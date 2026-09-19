import { loadConfig } from "../src/config/env";
import { createLogger, Logger } from "../src/observability/logger";
import { createLlmProvider, LlmProvider } from "../src/agent/llm.provider";
import { buildSystemPrompt } from "../src/agent/system-prompt";
import { runAgent } from "../src/agent/agent";
import { AgentAction } from "../src/agent/schemas";
import { Flat, HistoryEntry } from "../src/types";
import { baseFlat, ConversationScenario, scenarios } from "../tests/conversations/scenarios";
import { applyActions, evaluate } from "../tests/conversations/evaluate";

interface ScenarioResult {
  name: string;
  failures: string[];
}

async function runScenario(
  scenario: ConversationScenario,
  llm: LlmProvider,
  logger: Logger,
): Promise<ScenarioResult> {
  const flat: Flat = { ...baseFlat, ...scenario.initialCRMState };
  const history: HistoryEntry[] = [];
  const actions: AgentAction[] = [];
  let stopped = false;

  for (const message of scenario.messages) {
    const systemPrompt = buildSystemPrompt({
      crm: { phone: flat.phone ?? "", contact: null, flats: [flat] },
      flats: [flat],
      primaryFlat: flat,
      isTerminal: false,
    });
    const { result } = await runAgent(llm, logger, { systemPrompt, history, batchText: message });
    actions.push(...result.actions);
    applyActions(flat, result.actions);
    if (result.stopConversation) stopped = true;
    history.push({ role: "user", content: message, ts: Date.now() });
    if (result.reply) history.push({ role: "assistant", content: result.reply, ts: Date.now() });
  }

  return { name: scenario.name, failures: evaluate(scenario, actions, flat, stopped) };
}

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, MOCK_LLM: "false" });
  if (!config.llmApiKey) {
    console.error("LLM_API_KEY is required to run `npm run eval`.");
    process.exit(1);
  }

  const logger = createLogger({ level: "warn", pretty: false });
  const llm = createLlmProvider(config, logger);

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
