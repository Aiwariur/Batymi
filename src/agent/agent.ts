import { HistoryEntry } from "../types";
import { Logger } from "../observability/logger";
import { ChatMessage, LlmProvider } from "./llm.provider";
import { AgentResult, actionSchema, agentResultSchema, rentalTermsDataSchema } from "./schemas";

export class AgentOutputError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

interface ParsedAgentResult {
  result: AgentResult;
  discardedActions: number;
  discardedFields: string[];
}

function tryParseAgentResult(raw: string): ParsedAgentResult | null {
  let text = raw.trim();
  const fence = text.match(/```(?:json)?\s*([\s\S]*?)```/i);
  if (fence?.[1]) text = fence[1].trim();

  const firstBrace = text.indexOf("{");
  const lastBrace = text.lastIndexOf("}");
  if (firstBrace !== -1 && lastBrace > firstBrace) {
    text = text.slice(firstBrace, lastBrace + 1);
  }

  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    return null;
  }
  const parsed = agentResultSchema.safeParse(json);
  if (parsed.success) return { result: parsed.data, discardedActions: 0, discardedFields: [] };

  // One unsupported field (often a guessed commission enum) should not throw
  // away independently valid owner facts from the same JSON response.
  if (!json || typeof json !== "object" || Array.isArray(json)) return null;
  const object = json as Record<string, unknown>;
  const reply = typeof object.reply === "string" ? object.reply : "";
  const stopConversation = typeof object.stopConversation === "boolean" ? object.stopConversation : false;
  if (!Array.isArray(object.actions)) return null;
  const actions: AgentResult["actions"] = [];
  const discardedFields: string[] = [];
  let discardedActions = 0;
  for (const candidate of object.actions) {
    const valid = actionSchema.safeParse(candidate);
    if (valid.success) {
      actions.push(valid.data);
      continue;
    }
    if (
      candidate && typeof candidate === "object" &&
      (candidate as Record<string, unknown>).type === "update_rental_terms" &&
      (candidate as Record<string, unknown>).data && typeof (candidate as Record<string, unknown>).data === "object"
    ) {
      const source = (candidate as { data: Record<string, unknown> }).data;
      const safeData: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(source)) {
        const field = rentalTermsDataSchema.safeParse({ [key]: value });
        if (field.success) safeData[key] = (field.data as Record<string, unknown>)[key];
        else discardedFields.push(key);
      }
      const salvaged = actionSchema.safeParse({ ...(candidate as object), data: safeData });
      if (salvaged.success) {
        actions.push(salvaged.data);
        continue;
      }
    }
    discardedActions += 1;
  }
  return {
    result: { reply, actions, stopConversation },
    discardedActions,
    discardedFields,
  };
}

export interface RunAgentInput {
  systemPrompt: string;
  history: HistoryEntry[];
  batchText: string;
}

export interface RunAgentOutput {
  result: AgentResult;
  raw: string;
}

export async function runAgent(
  llm: LlmProvider,
  logger: Logger,
  input: RunAgentInput,
): Promise<RunAgentOutput> {
  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map((entry) => ({ role: entry.role, content: entry.content })),
    { role: "user", content: input.batchText },
  ];

  const startedAt = Date.now();
  logger.info("llm.started");
  let raw = await llm.complete(messages);
  let parsed = tryParseAgentResult(raw);

  if (parsed && (parsed.discardedActions > 0 || parsed.discardedFields.length > 0)) {
    logger.warn(
      { discardedActions: parsed.discardedActions, discardedFields: parsed.discardedFields },
      "llm.partial_output.salvaged",
    );
  }

  if (!parsed) {
    logger.warn({ rawPreview: raw.slice(0, 300) }, "llm.invalid_output.retry");
    const repairMessages: ChatMessage[] = [
      ...messages,
      { role: "assistant", content: raw },
      {
        role: "user",
        content:
          'Твой предыдущий ответ не соответствует формату. Верни СТРОГО валидный JSON вида {"reply": string, "actions": [...], "stopConversation": boolean} без markdown.',
      },
    ];
    raw = await llm.complete(repairMessages);
    parsed = tryParseAgentResult(raw);
    if (parsed && (parsed.discardedActions > 0 || parsed.discardedFields.length > 0)) {
      logger.warn(
        { discardedActions: parsed.discardedActions, discardedFields: parsed.discardedFields },
        "llm.partial_output.salvaged_after_retry",
      );
    }
    if (!parsed) {
      logger.error({ rawPreview: raw.slice(0, 300) }, "llm.invalid_output.fallback");
      const language = /[\u10a0-\u10ff]/.test(input.batchText)
        ? "ka"
        : /[А-Яа-яЁё]/.test(input.batchText)
          ? "ru"
          : /\b(da+|mozhno|mozhna|sobstvennik|sotrudnich|god|vid)\b/i.test(input.batchText)
            ? "ru"
            : "en";
      const reply = language === "ru"
        ? "Извините, я не уверен, что правильно понял. Уточните, пожалуйста, ваш ответ?"
        : language === "ka"
          ? "ბოდიშს გიხდით, დარწმუნებული არ ვარ, სწორად გავიგე თუ არა. გთხოვთ, დააზუსტოთ თქვენი პასუხი?"
          : "Sorry, I am not sure I understood correctly. Could you please clarify your answer?";
      parsed = { result: { reply, actions: [], stopConversation: false }, discardedActions: 0, discardedFields: [] };
    }
  }

  logger.info({ duration: Date.now() - startedAt, actions: parsed.result.actions.length }, "llm.completed");
  return { result: parsed.result, raw };
}
