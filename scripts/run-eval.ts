import { loadConfig } from "../src/config/env";
import { createLogger, Logger } from "../src/observability/logger";
import { createLlmProvider, ChatMessage, LlmProvider } from "../src/agent/llm.provider";
import { buildSystemPrompt, resolvePhase } from "../src/agent/system-prompt";
import { runAgent } from "../src/agent/agent";
import { AgentAction } from "../src/agent/schemas";
import { explicitCooperationConsent, finalizeAgentResponse } from "../src/conversation/conversation.service";
import { HistoryEntry } from "../src/types";
import { ConversationScenario, scenarios } from "../tests/conversations/scenarios";
import { applyActions, buildListing, evaluate, EvaluatedTurn } from "../tests/conversations/evaluate";

interface ScenarioResult {
  name: string;
  failures: string[];
  turnDiagnostics?: string[];
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Транспортные сбои провайдера (таймауты/429/5xx) не должны ронять eval. */
function withTransportRetry(llm: LlmProvider, logger: Logger): LlmProvider {
  return {
    async complete(messages: ChatMessage[]) {
      for (let attempt = 1; ; attempt += 1) {
        try {
          return await llm.complete(messages);
        } catch (error) {
          if (attempt >= 3 || !(error as { retryable?: boolean }).retryable) throw error;
          logger.warn({ attempt }, "eval.llm.retry");
          await sleep(3000 * attempt);
        }
      }
    },
  };
}

async function runScenario(
  scenario: ConversationScenario,
  llm: LlmProvider,
  logger: Logger,
): Promise<ScenarioResult> {
  const listing = buildListing(scenario.initialCRMState);
  const priorHistory = scenario.priorHistory ?? [];
  const history: HistoryEntry[] = priorHistory.map((entry, index) => ({
    ...entry,
    ts: Date.now() - (priorHistory.length - index),
  }));
  const actions: AgentAction[] = [];
  const turns: EvaluatedTurn[] = [];
  const turnDiagnostics: string[] = [];
  let stopped = false;

  for (const message of scenario.messages) {
    const crmStatusBefore = String(listing.crm_status ?? "");
    const contactTypeBefore = String(listing.contact_type ?? "<unset>");
    const phase = resolvePhase(listing.crm_status);
    const consentSeen = explicitCooperationConsent(message, history);
    const systemPrompt = buildSystemPrompt({
      crm: { phone: listing.phone ?? "", contact: null, listings: [listing] },
      listings: [listing],
      primaryListing: listing,
      phase,
    });
    const { result } = await runAgent(llm, logger, { systemPrompt, history, batchText: message });
    // Use the same gates and reply/stop safeguards as the live conversation service.
    const guarded = finalizeAgentResponse({
      result,
      phase,
      history,
      batchText: message,
      listings: [listing],
      primaryListing: listing,
    });
    const { gate } = guarded;
    actions.push(...gate.allowed);
    applyActions(listing, gate.allowed);
    if (guarded.stopConversation) stopped = true;
    history.push({ role: "user", content: message, ts: Date.now() });
    const reply = guarded.reply;
    if (reply) history.push({ role: "assistant", content: reply, ts: Date.now() });
    turns.push({
      crmStatusBefore,
      crmStatusAfter: String(listing.crm_status ?? ""),
      crmStateAfter: snapshotCRMState(listing),
      actions: gate.allowed,
      reply,
      stopped: guarded.stopConversation,
    });
    turnDiagnostics.push(
      `turn ${turns.length}: phase=${phase}, status=${crmStatusBefore}->${String(listing.crm_status ?? "")}, ` +
      `owner=${contactTypeBefore}->${String(listing.contact_type ?? "<unset>")}, consentDetected=${consentSeen}, ` +
      `modelActions=${summarizeActions(result.actions)}, acceptedActions=${summarizeActions(gate.allowed)}, ` +
      `stop=${guarded.stopConversation}, reply=${JSON.stringify(replySnippet(reply))}`,
    );
    // Production stops processing a conversation after a terminal response.
    if (guarded.stopConversation) break;
  }

  return { name: scenario.name, failures: evaluate(scenario, actions, listing, stopped, turns), turnDiagnostics };
}

function snapshotCRMState(listing: ReturnType<typeof buildListing>) {
  const { rental_terms, ...fields } = structuredClone(listing);
  return rental_terms ? { ...fields, rentalTerms: rental_terms } : fields;
}

function summarizeActions(actions: AgentAction[]): string {
  return `[${actions.map((action) => {
    if (action.type === "set_crm_status") return `${action.type}:${action.status}`;
    if (action.type === "set_contact_type") return `${action.type}:${action.contactType}`;
    if (action.type === "update_deal_info" || action.type === "update_rental_terms") {
      return `${action.type}(${Object.keys(action.data).join(",")})`;
    }
  }).join("; ")}]`;
}

function replySnippet(reply: string): string {
  if (reply.length <= 180) return reply;
  return `${reply.slice(0, 80)} … ${reply.slice(-80)}`;
}

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, MOCK_LLM: "false" });
  if (!config.llmApiKey) {
    console.error("LLM_API_KEY is required to run `npm run eval`.");
    process.exit(1);
  }

  const logger = createLogger({ level: "warn", pretty: false });
  const llm = withTransportRetry(createLlmProvider(config, logger), logger);

  const scenarioArg = process.argv.slice(2).find((arg) => arg.startsWith("--scenario="));
  const requestedScenario = scenarioArg?.slice("--scenario=".length);
  const selectedScenarios = requestedScenario
    ? scenarios.filter((scenario) => scenario.name === requestedScenario)
    : scenarios;
  if (requestedScenario && selectedScenarios.length === 0) {
    console.error(`Unknown scenario "${requestedScenario}". Available scenarios: ${scenarios.map((scenario) => scenario.name).join(", ")}`);
    process.exit(2);
  }

  const results: ScenarioResult[] = [];
  for (const scenario of selectedScenarios) {
    process.stdout.write(`Running ${scenario.name}...\r`);
    try {
      results.push(await runScenario(scenario, llm, logger));
    } catch (error) {
      results.push({ name: scenario.name, failures: [`scenario crashed: ${(error as Error).message}`] });
    }
  }

  const failed = results.filter((r) => r.failures.length > 0);
  const passed = results.length - failed.length;
  const passRate = ((passed / results.length) * 100).toFixed(1);

  console.log("\nConversation Eval\n");
  console.log(`Scenarios: ${results.length}`);
  console.log(`Passed: ${passed}`);
  console.log(`Failed: ${failed.length}`);
  console.log(`\nPass rate: ${passRate}%`);

  if (failed.length > 0) {
    console.log("\nFAILED:\n");
    failed.forEach((result, index) => {
      console.log(`#${index + 1} ${result.name}`);
      console.log("reason:");
      console.log(result.failures.join("; "));
      if (result.turnDiagnostics?.length) {
        console.log("turn diagnostics:");
        result.turnDiagnostics.forEach((diagnostic) => console.log(`  ${diagnostic}`));
      }
      console.log("");
    });
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("Eval failed:", error);
  process.exit(1);
});
