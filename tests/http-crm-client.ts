import { loadConfig } from "../src/config/env";
import { RealCrmClient } from "../src/crm/crm.client";
import { createLogger } from "../src/observability/logger";

const config = loadConfig({
  ...process.env,
  NODE_ENV: "test",
  MOCK_EXTERNALS: "false",
  MOCK_CRM: "false",
  MOCK_LLM: "true",
  MOCK_GREENAPI: "true",
  MOCK_TRANSCRIPTION: "true",
  GREENAPI_INSTANCES: JSON.stringify([{ id: "http-test-instance", token: "x" }]),
});
const client = new RealCrmClient(config, createLogger({ level: "silent", pretty: false }));

async function main(): Promise<void> {
  const phone = process.env.TEST_PHONE ?? "+995599123456";
  await client.updateDealInfo(phone, 8102, { window_view: "море" });
  await client.updateDealInfo(phone, 8102, { window_view: "" });
  await client.setStatus(8102, "agreed", { suppressTelegram: true });
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
