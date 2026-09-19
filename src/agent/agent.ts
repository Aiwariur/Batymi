import { HistoryEntry } from "../types";
import { Logger } from "../observability/logger";
import { ChatMessage, LlmProvider } from "./llm.provider";
import { AgentResult, agentResultSchema } from "./schemas";

export class AgentOutputError extends Error {
  constructor(message: string, readonly raw: string) {
    super(message);
    this.name = "AgentOutputError";
  }
}

function tryParseAgentResult(raw: string): AgentResult | null {
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
  return parsed.success ? parsed.data : null;
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
    if (!parsed) {
      throw new AgentOutputError("LLM returned invalid structured output after retry", raw);
    }
  }

  logger.info({ duration: Date.now() - startedAt, actions: parsed.actions.length }, "llm.completed");
  return { result: parsed, raw };
}
