import { HistoryEntry } from "../types";
import { Logger } from "../observability/logger";
import { ChatMessage, LlmProvider } from "./llm.provider";
import { AgentResult, agentResultSchema } from "./schemas";

export class AgentOutputError extends Error {
  constructor(message: string, readonly raw: string) { super(message); this.name = "AgentOutputError"; }
}
export interface RunAgentInput {
  systemPrompt: string;
  history: HistoryEntry[];
  batchText: string;
  feedback?: unknown;
  previousRaw?: string;
  executionResults?: unknown;
  allowRepair?: boolean;
  onRaw?: (raw: string) => Promise<void>;
}
export interface RunAgentOutput { result: AgentResult; raw: string; repaired: boolean }

export async function runAgent(llm: LlmProvider, logger: Logger, input: RunAgentInput): Promise<RunAgentOutput> {
  const final = input.executionResults !== undefined;
  const messages: ChatMessage[] = [
    { role: "system", content: input.systemPrompt },
    ...input.history.map(entry => ({ role: entry.role, content: entry.content })),
    { role: "user", content: input.batchText },
  ];
  if (input.previousRaw !== undefined) messages.push({ role: "assistant", content: input.previousRaw });
  if (input.feedback !== undefined) messages.push({ role: "system", content: "ACTION_VALIDATION_ERROR: " + JSON.stringify(input.feedback) + ". Исправь предыдущий план. Записи ещё не выполнялись. Сохрани валидные факты и selectedListingId предыдущего плана; каждый адресованный action сам по себе не заменяет обязательный selectedListingId результата." });
  if (final) messages.push({ role: "system", content: "CRM_EXECUTION_RESULTS: " + JSON.stringify(input.executionResults) + ". Все перечисленные действия уже выполнены. Дай окончательный короткий ответ собственнику, actions строго [], не повторяй действия. Учитывай обновлённый CRM и исходное сообщение. Сохрани язык и письменность proposedReply, если они соответствуют последнему user: русский транслит должен остаться транслитом, английский — английским, грузинский — грузинским. Язык этой инструкции и прошлых сообщений не задаёт язык ответа. После qualified — короткая благодарность без нового вопроса, stopConversation=true. В тексте собственнику не называй внутренние статусы/CRM/квалификацию заявки и не утверждай передачу менеджеру или клиентам без такого действия; подтверди только сохранённые условия. При незавершённом разговоре задай один следующий вопрос ровно один раз: не дублируй вопрос из proposedReply и не склеивай проект с новой версией ответа." });
  let raw = "";
  for (let attempt = 0; attempt < (input.allowRepair === false ? 1 : 2); attempt++) {
    raw = await llm.complete(messages);
    await input.onRaw?.(raw);
    try {
      const result = agentResultSchema.parse(JSON.parse(raw.trim()));
      if (final && result.actions.length > 0) throw new Error("final_response_actions_must_be_empty");
      if (result.actions.length === 0 && !result.reply.trim()) throw new Error("empty final reply");
      logger.info({ actions: result.actions.length, final }, "llm.completed");
      return { result, raw, repaired: attempt > 0 };
    } catch (error) {
      const reason = error instanceof Error ? error.message : "invalid JSON";
      logger.warn({ attempt, final }, "llm.invalid_output");
      messages.push({ role: "assistant", content: raw }, { role: "system", content: "Ошибка формата: " + reason + '. Верни только JSON {"reply":string,"actions":[],"stopConversation":boolean} с допустимыми действиями из схемы. ' + (final ? "actions должны быть пустыми." : "") });
    }
  }
  throw new AgentOutputError("model output invalid after bounded repair", raw);
}
