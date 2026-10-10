import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { ChatMessage, LlmError, OpenAiCompatibleProvider } from "../../src/agent/llm.provider";
import { createLogger } from "../../src/observability/logger";

const messages: ChatMessage[] = [
  { role: "system", content: "Return JSON." },
  { role: "user", content: "Hello" },
];

function provider() {
  const config = loadConfig({
    ...process.env,
    NODE_ENV: "test",
    MOCK_EXTERNALS: "false",
    MOCK_LLM: "false",
    LLM_API_KEY: "test-key",
    LLM_BASE_URL: "https://llm.test/v1",
    LLM_MODEL: "test-model",
    LLM_MAX_TOKENS: "2048",
    LLM_TEMPERATURE: "0.7",
  });
  return new OpenAiCompatibleProvider(config, createLogger({ level: "silent", pretty: false }));
}

describe("OpenAiCompatibleProvider", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("caps the request payload at maxTokens 512 and honors temperature zero", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await expect(provider().complete(messages, { maxTokens: 512, temperature: 0 })).resolves.toBe("{}");

    const request = fetchMock.mock.calls[0][1] as RequestInit;
    const body = JSON.parse(String(request.body));
    expect(body).toMatchObject({ model: "test-model", messages, max_tokens: 512, temperature: 0 });
  });

  it("marks 402 in-flight request errors retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Too many in-flight requests" },
    }), { status: 402, headers: { "Content-Type": "application/json" } })));

    const error = await provider().complete(messages).catch(reason => reason);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 402, retryable: true });
  });

  it("keeps plain insufficient-credit 402 errors non-retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      error: { message: "Insufficient credits" },
    }), { status: 402, headers: { "Content-Type": "application/json" } })));

    const error = await provider().complete(messages).catch(reason => reason);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ status: 402, retryable: false });
  });

  it("treats an empty successful response as retryable", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } })));

    const error = await provider().complete(messages).catch(reason => reason);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ retryable: true });
  });
});
