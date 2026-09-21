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
const AGREE_RE = /(можно|готов|согласен|давай|конечно|\byes\b|\bok\b|^да\b|сдаю)/i;
const REFUSE_RE = /(не\s+сда|не\s+хочу|отказ|не\s+интерес|не\s+буду|\bno\b)/i;
const CONFIRM_RE = /(всё\s+верно|все\s+верно|подтвержда|всё\s+правильно|всё\s+верно|да,?\s+(всё|все)\s+(верно|так))/i;

const PRICE_MONTH_RE = /(\d{3,5})\s*(?:\$|usd|долл)?\s*(?:в\s*месяц|\/\s*мес|за\s*месяц|месяц)/i;
const PRICE_DOLLAR_RE = /\$\s*(\d{3,5})/;
const DEPOSIT_RE = /(депозит|залог)[^\d]{0,12}(\d{3,5})?/i;
const LEASE_MONTHS_RE = /(?:на|минимум|сроком)[^\d]{0,10}(\d{1,2})\s*(мес|год)/i;
const WINDOW_RE = /(море|гор(?:а|ы|а)|двор|улиц[аы])/i;
const CADASTRAL_RE = /(?:кадастр[^\d]{0,15})?(\d{2}[.,]\d{2}[.,]\d{2}(?:[.,]\d+)*)/i;
const COMPLEX_RE = /(orbi(?:\s+city)?|batumi\s+towers|blue\s+ocean|жк\s+([a-zа-яё\s-]{2,30}))/i;
const CONSENT_RE = /(публику|размеща|выкладывай|объявлен)/i;
const AVAILABLE_RE = /(свободн|доступн|сдаёт|сдает)/i;

function detectPhase(system: string): "primary" | "agreed" | "qualified" {
  if (system.includes("Статус qualified")) return "qualified";
  if (system.includes("Фаза 2")) return "agreed";
  return "primary";
}

function mockResult(text: string, system: string): string {
  const lower = text.toLowerCase();
  const actions: unknown[] = [];
  const phase = detectPhase(system);

  if (REALTOR_RE.test(lower)) {
    actions.push({ type: "set_contact_type", contactType: "realtor" });
    return JSON.stringify({
      reply:
        "Понял, спасибо. Мы работаем только напрямую с собственниками, поэтому не буду продолжать автоматическое предложение по этому контакту.",
      actions,
      stopConversation: true,
    });
  }

  if (phase === "qualified") {
    return JSON.stringify({
      reply: "Понял, спасибо. Данные по вашей квартире у нас зафиксированы.",
      actions: [],
      stopConversation: false,
    });
  }

  if (OWNER_RE.test(lower)) {
    actions.push({ type: "set_contact_type", contactType: "owner" });
  }

  const rental: Record<string, unknown> = {};
  const priceMatch = text.match(PRICE_MONTH_RE) ?? text.match(PRICE_DOLLAR_RE);
  if (priceMatch) {
    rental.price = Number(priceMatch[1]);
    rental.currency = "USD";
  }
  const depositMatch = text.match(DEPOSIT_RE);
  if (depositMatch?.[2]) rental.deposit_amount = Number(depositMatch[2]);
  const leaseMatch = text.match(LEASE_MONTHS_RE);
  if (leaseMatch) {
    rental.minimum_lease_months = leaseMatch[2].toLowerCase() === "год" ? 12 : Number(leaseMatch[1]);
  }
  if (AVAILABLE_RE.test(lower)) rental.availability_status = "available";
  if (CONSENT_RE.test(lower)) rental.publication_consent = true;
  if (/\d+\s*%/.test(text) && /комисс/i.test(lower)) {
    rental.commission_type = "percent_month";
    rental.commission_value = (text.match(/(\d+)\s*%/)?.[1] ?? "") + "%";
    rental.commission_payer = "owner";
  }
  if (Object.keys(rental).length > 0) {
    actions.push({ type: "update_rental_terms", data: rental });
  }

  const deal: Record<string, string> = {};
  const windowMatch = text.match(WINDOW_RE);
  if (windowMatch) deal.window_view = windowMatch[1].toLowerCase();
  const cadastralMatch = text.match(CADASTRAL_RE);
  if (cadastralMatch?.[1]) deal.cadastral_code = cadastralMatch[1].replace(/,/g, ".");
  const complexMatch = text.match(COMPLEX_RE);
  if (complexMatch) {
    deal.complex_name = (complexMatch[2] ?? complexMatch[1] ?? "").trim() || "Orbi City";
    deal.complex_name = deal.complex_name.replace(/\b\w/g, (c) => c.toUpperCase());
  }
  if (/нет\s+жк|не\s+в\s+жк|без\s+жк/i.test(lower)) deal.complex_name = "нет ЖК";
  if (Object.keys(deal).length > 0) {
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
    if (phase === "agreed") {
      const complete = Boolean(
        (deal.window_view || /вид/i.test(lower)) &&
          (deal.cadastral_code || /кадастр/i.test(lower)) &&
          rental.publication_consent,
      );
      if (complete || CONFIRM_RE.test(lower)) {
        actions.push({ type: "set_crm_status", status: "qualified" });
        return JSON.stringify({
          reply: "Отлично, всё зафиксировал. Готовим публикацию, менеджер свяжется при необходимости.",
          actions,
          stopConversation: true,
        });
      }
      return JSON.stringify({
        reply: "Спасибо, зафиксировал. Подскажите ещё кадастровый номер и вид из окон, если есть.",
        actions,
        stopConversation: false,
      });
    }
    actions.push({ type: "set_crm_status", status: "agreed" });
    return JSON.stringify({
      reply: "Отлично, можем взять квартиру в работу. Подскажите минимальный срок, депозит и условия комиссии?",
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
    const system = messages.find((m) => m.role === "system")?.content ?? "";
    const text = lastUser?.content ?? "";
    this.logger.debug("llm.mock.completed");
    return mockResult(text, system);
  }
}

export function createLlmProvider(config: Config, logger: Logger): LlmProvider {
  return config.mockLlm
    ? new MockLlmProvider(logger)
    : new OpenAiCompatibleProvider(config, logger);
}
