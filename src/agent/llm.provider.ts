import { Config } from "../config/env";
import { Logger } from "../observability/logger";

export interface ChatMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export class LlmError extends Error {
  constructor(
    message: string,
    readonly retryable: boolean,
    readonly status?: number,
  ) {
    super(message);
    this.name = "LlmError";
  }
}

export interface CompletionOptions {
  maxTokens?: number;
  temperature?: number;
}

export interface LlmProvider {
  complete(messages: ChatMessage[], options?: CompletionOptions): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 60000;

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async complete(messages: ChatMessage[], options: CompletionOptions = {}): Promise<string> {
    if (!this.config.llmApiKey) throw new LlmError("LLM_API_KEY is not configured", false);

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.config.llmBaseUrl}/chat/completions`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Authorization: `Bearer ${this.config.llmApiKey}`,
        },
        body: JSON.stringify({
          model: this.config.llmModel,
          messages,
          max_tokens: Math.min(this.config.llmMaxTokens, options.maxTokens ?? this.config.llmMaxTokens),
          temperature: options.temperature ?? this.config.llmTemperature,
          frequency_penalty: this.config.llmFrequencyPenalty,
          top_p: this.config.llmTopP,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        let reservedCredits = false;
        if (response.status === 402) {
          try {
            const detail = JSON.parse(body) as {error?: {message?: string}};
            reservedCredits = typeof detail.error?.message === "string" && detail.error.message.includes("in-flight requests");
          } catch { /* Ordinary payment failures remain operator-visible. */ }
        }
        const retryable = reservedCredits || response.status === 429 || response.status >= 500;
        throw new LlmError(`LLM request failed: HTTP ${response.status}`, retryable, response.status);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
      };
      const content = data.choices?.[0]?.message?.content;
      if (!content) throw new LlmError("LLM returned an empty response", true);
      return content;
    } catch (error) {
      if (error instanceof LlmError) throw error;
      throw new LlmError(`LLM request failed: ${(error as Error).message}`, true);
    } finally {
      clearTimeout(timer);
    }
  }
}

/** Transport-only mock. Dialogue acceptance uses explicit fixtures or the real provider. */
export class MockLlmProvider implements LlmProvider {
  constructor(private readonly logger: Logger) {}
  async complete(_messages: ChatMessage[]): Promise<string> {
    this.logger.debug("llm.mock");
    return JSON.stringify({ reply: "Тестовый ответ.", actions: [], stopConversation: false });
  }
}
export function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  return config.mockLlm
    ? new MockLlmProvider(logger)
    : new OpenAiCompatibleProvider(config, logger);
}
