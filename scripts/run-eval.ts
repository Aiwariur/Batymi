import { loadConfig } from "../src/config/env";
import { createLogger, Logger } from "../src/observability/logger";
import { createLlmProvider, ChatMessage, LlmProvider } from "../src/agent/llm.provider";
import { buildSystemPrompt, resolvePhase } from "../src/agent/system-prompt";
import { runAgent } from "../src/agent/agent";
import { applyGates } from "../src/agent/gates";
import { AgentAction } from "../src/agent/schemas";
import { HistoryEntry } from "../src/types";
import { ConversationScenario, scenarios } from "../tests/conversations/scenarios";
import { applyActions, buildListing, evaluate } from "../tests/conversations/evaluate";

interface ScenarioResult {
  name: string;
  failures: string[];
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
  const history: HistoryEntry[] = [];
  const actions: AgentAction[] = [];
  let stopped = false;

  for (const message of scenario.messages) {
    const phase = resolvePhase(listing.crm_status);
    const systemPrompt = buildSystemPrompt({
      crm: { phone: listing.phone ?? "", contact: null, listings: [listing] },
      listings: [listing],
      primaryListing: listing,
      phase,
    });
    const { result } = await runAgent(llm, logger, { systemPrompt, history, batchText: message });
    // eval повторяет прод-пайплайн: действия LLM проходят те же гейты
    const gate = applyGates(result.actions, {
      listings: [listing],
      primaryListingId: listing.id,
      phase,
    });
    actions.push(...gate.allowed);
    applyActions(listing, gate.allowed);
    if (result.stopConversation) stopped = true;
    history.push({ role: "user", content: message, ts: Date.now() });
    if (result.reply) history.push({ role: "assistant", content: result.reply, ts: Date.now() });
  }

  return { name: scenario.name, failures: evaluate(scenario, actions, listing, stopped) };
}

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, MOCK_LLM: "false" });
  if (!config.llmApiKey) {
    console.error("LLM_API_KEY is required to run `npm run eval`.");
    process.exit(1);
  }

  const logger = createLogger({ level: "warn", pretty: false });
  const llm = withTransportRetry(createLlmProvider(config, logger), logger);

  const results: ScenarioResult[] = [];
  for (const scenario of scenarios) {
    process.stdout.write(`Running ${scenario.name}...\r`);
    results.push(await runScenario(scenario, llm, logger));
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
      console.log("");
    });
    process.exit(1);
  }
}

void main().catch((error) => {
  console.error("Eval failed:", error);
  process.exit(1);
});
