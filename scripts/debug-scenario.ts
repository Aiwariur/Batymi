import { loadConfig } from "../src/config/env";
import { createLogger } from "../src/observability/logger";
import { createLlmProvider } from "../src/agent/llm.provider";
import { buildSystemPrompt } from "../src/agent/system-prompt";
import { runAgent } from "../src/agent/agent";
import { Flat, HistoryEntry } from "../src/types";
import { baseFlat, findScenario } from "../tests/conversations/scenarios";
import { applyActions } from "../tests/conversations/evaluate";

const names = process.argv.slice(2);
if (names.length === 0) {
  console.error("Usage: tsx scripts/debug-scenario.ts <scenario-name> [more-names...]");
  process.exit(1);
}

async function main(): Promise<void> {
  const config = loadConfig({ ...process.env, MOCK_LLM: "false" });
  if (!config.llmApiKey) {
    console.error("LLM_API_KEY is required.");
    process.exit(1);
  }
  const logger = createLogger({ level: "warn", pretty: false });
  const llm = createLlmProvider(config, logger);

  for (const name of names) {
    const scenario = findScenario(name);
    if (!scenario) {
      console.error(`Unknown scenario: ${name}`);
      process.exit(1);
    }

    const flat: Flat = { ...baseFlat, ...scenario.initialCRMState };
    const history: HistoryEntry[] = [];
    console.log(`\n=== ${scenario.name} ===`);
    if (scenario.note) console.log(`note: ${scenario.note}`);
    console.log(`initial CRM: ${JSON.stringify(scenario.initialCRMState)}`);

    for (const message of scenario.messages) {
      const systemPrompt = buildSystemPrompt({
        crm: { phone: flat.phone ?? "", contact: null, flats: [flat] },
        flats: [flat],
        primaryFlat: flat,
        isTerminal: false,
      });
      const { result } = await runAgent(llm, logger, { systemPrompt, history, batchText: message });
      console.log(`\nuser: ${message}`);
      console.log(`reply: ${result.reply}`);
      console.log(`actions: ${JSON.stringify(result.actions)}`);
      console.log(`stopConversation: ${result.stopConversation}`);
      applyActions(flat, result.actions);
      history.push({ role: "user", content: message, ts: Date.now() });
      if (result.reply) history.push({ role: "assistant", content: result.reply, ts: Date.now() });
    }
    console.log(`\nfinal CRM: contact_type=${flat.contact_type} crm_status=${flat.crm_status}`);
  }
}

void main().catch((error) => {
  console.error("Debug run failed:", error);
  process.exit(1);
});
