import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { RealCrmClient } from "../../src/crm/crm.client";
import { createLogger } from "../../src/observability/logger";

describe("RealCrmClient writes", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("preserves an applied:false status result from CRM", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, applied: false, status: "disagreed",
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);
    const config = loadConfig({
      ...process.env,
      NODE_ENV: "test",
      MOCK_EXTERNALS: "false",
      MOCK_CRM: "false",
      MOCK_LLM: "true",
      MOCK_GREENAPI: "true",
      MOCK_TRANSCRIPTION: "true",
      CRM_BASE_URL: "http://crm.test",
      CRM_API_KEY: "test-key",
      GREENAPI_INSTANCES: "[]",
    });
    const crm = new RealCrmClient(config, createLogger({ level: "silent", pretty: false }));

    await expect(crm.setStatus(101, "agreed")).resolves.toEqual({
      applied: false,
      status: "disagreed",
    });
  });
});
