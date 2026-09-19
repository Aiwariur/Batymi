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

export interface LlmProvider {
  complete(messages: ChatMessage[]): Promise<string>;
}

const REQUEST_TIMEOUT_MS = 60000;

export class OpenAiCompatibleProvider implements LlmProvider {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async complete(messages: ChatMessage[]): Promise<string> {
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
          max_tokens: this.config.llmMaxTokens,
          temperature: this.config.llmTemperature,
          frequency_penalty: this.config.llmFrequencyPenalty,
          top_p: this.config.llmTopP,
          response_format: { type: "json_object" },
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        const retryable = response.status === 429 || response.status >= 500;
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

const REALTOR_RE = /(риелтор|риэлтор|агент|брокер|realtor)/i;
const OWNER_RE = /(собственник|хозяин|владелец|owner)/i;
const AGREE_RE = /(можно|готов|согласен|давай|конечно|\byes\b|\bok\b|^да\b)/i;
const REFUSE_RE = /(не\s+прода|не\s+хочу|отказ|не\s+интерес|\bno\b)/i;
const PRICE_RE = /(\d[\d\s]{2,})\s*(?:тыс|000|usd|\$|на\s+руки)?/i;

function mockResult(text: string): string {
  const actions: unknown[] = [];
  const lower = text.toLowerCase();

  if (REALTOR_RE.test(lower)) {
    actions.push({ type: "set_contact_type", contactType: "realtor" });
    return JSON.stringify({
      reply: "Понял, вы ведёте эту квартиру. У нас есть покупатели, можем сотрудничать. Готовы обсудить условия?",
      actions,
      stopConversation: true,
    });
  }

  if (OWNER_RE.test(lower)) {
    actions.push({ type: "set_contact_type", contactType: "owner" });
  }

  const priceMatch = text.match(PRICE_RE);
  const deal: Record<string, string> = {
    commission_type: "",
    commission_value: "",
    price_net: "",
    window_view: "",
    complex_name: "",
    cadastral_code: "",
    agent_notes: "",
  };
  if (/на\s+руки|сверху/i.test(lower)) {
    deal.commission_type = "on_top";
    if (priceMatch) deal.price_net = priceMatch[1].replace(/\s/g, "");
  }
  if (/море/i.test(lower)) deal.window_view = "море";
  if (/(жк|orbi|complex)/i.test(lower)) {
    const complex = text.match(/(?:жк|orbi)\s*([\w-]+)?/i);
    deal.complex_name = complex?.[1] ? complex[1] : "Orbi";
  }
  if (Object.values(deal).some(Boolean)) {
    actions.push({ type: "update_deal_info", data: deal });
  }

  if (REFUSE_RE.test(lower) && !AGREE_RE.test(lower)) {
    actions.push({ type: "set_crm_status", status: "disagreed" });
    return JSON.stringify({
      reply: "Понял, спасибо. Если ситуация изменится — напишите.",
      actions,
      stopConversation: true,
    });
  }

  if (OWNER_RE.test(lower) && AGREE_RE.test(lower)) {
    actions.push({ type: "set_crm_status", status: "agreed" });
    return JSON.stringify({
      reply: "Отлично, можем взять квартиру в работу. Подскажите, как удобнее по комиссии?",
      actions,
      stopConversation: false,
    });
  }

  return JSON.stringify({
    reply: "Подскажите, пожалуйста, вы собственник или риелтор?",
    actions,
    stopConversation: false,
  });
}

export class MockLlmProvider implements LlmProvider {
  constructor(private readonly logger: Logger) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    const lastUser = [...messages].reverse().find((m) => m.role === "user");
    const text = lastUser?.content ?? "";
    this.logger.debug("llm.mock.completed");
    return mockResult(text);
  }
}

export function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  return config.mockLlm
    ? new MockLlmProvider(logger)
    : new OpenAiCompatibleProvider(config, logger);
}
