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

describe("RealCrmClient.pushTranscript", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("posts the audio transcript keyed by instance and message id", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      success: true, updated: true,
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

    await crm.pushTranscript({ instanceId: "710722742102", messageId: "audio-1", text: "Квартира сдаётся" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("http://crm.test/interactions/transcript");
    expect(init.method).toBe("POST");
    expect(init.headers["X-API-Key"]).toBe("test-key");
    expect(JSON.parse(init.body)).toEqual({
      instance_id: "710722742102", message_id: "audio-1", text: "Квартира сдаётся",
    });
  });
});
