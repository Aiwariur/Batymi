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
    LLM_FREQUENCY_PENALTY: "0.5",
    LLM_TOP_P: "0.9",
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

  it("sends json mode and sampling penalties by default", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "{}" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().complete(messages);

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body.response_format).toEqual({ type: "json_object" });
    expect(body.frequency_penalty).toBe(0.5);
    expect(body.top_p).toBe(0.9);
  });

  it("omits response_format and sampling penalties when jsonMode is false", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: '{"action":"reply"}' } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    await provider().complete(messages, { maxTokens: 2000, temperature: 0.3, jsonMode: false });

    const body = JSON.parse(String((fetchMock.mock.calls[0][1] as RequestInit).body));
    expect(body).not.toHaveProperty("response_format");
    expect(body).not.toHaveProperty("frequency_penalty");
    expect(body).not.toHaveProperty("top_p");
    expect(body).toMatchObject({ max_tokens: 2000, temperature: 0.3 });
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
    const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({
      choices: [{ message: { content: "" } }],
    }), { status: 200, headers: { "Content-Type": "application/json" } }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await provider().complete(messages).catch(reason => reason);
    expect(error).toBeInstanceOf(LlmError);
    expect(error).toMatchObject({ retryable: true });
  });

  it("retries an empty success in-place before giving the queue a retryable error", async () => {
    vi.useFakeTimers();
    try {
      const fetchMock = vi.fn()
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }))
        .mockResolvedValueOnce(new Response(JSON.stringify({ choices: [{ message: { content: "{\"action\":\"reply\"}" } }] }), { status: 200, headers: { "Content-Type": "application/json" } }));
      vi.stubGlobal("fetch", fetchMock);

      const pending = provider().complete(messages, { jsonMode: false });
      const advanced = pending.then(() => undefined, () => undefined);
      await vi.advanceTimersByTimeAsync(5000);
      await advanced;
      await expect(pending).resolves.toBe("{\"action\":\"reply\"}");
      expect(fetchMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });
});
