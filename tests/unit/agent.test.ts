import { describe, expect, it, vi } from "vitest";
import { AgentOutputError, runAgent } from "../../src/agent/agent";
import { ChatMessage } from "../../src/agent/llm.provider";
import { Logger } from "../../src/observability/logger";

const logger = {
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
} as unknown as Logger;

describe("agent structured-output contract", () => {
  it("returns an action error alongside the previous proposal so selection survives repair", async () => {
    const previousRaw = JSON.stringify({ reply: "Проект", selectedListingId: 202,
      actions: [{ type: "set_crm_status", listingId: 202, status: "qualified" }], stopConversation: true });
    const llm = { complete: vi.fn(async (messages: ChatMessage[]) => {
      const previous = messages.find(message => message.role === "assistant");
      expect(previous?.content).toBe(previousRaw);
      expect(messages.filter(message => message.role === "user")).toHaveLength(1);
      expect(messages.at(-1)?.content).toContain("multi_listing_scope_requires_manager");
      const selection = JSON.parse(previous!.content).selectedListingId;
      return JSON.stringify({ reply: "Потребуется проверка менеджера", selectedListingId: selection,
        actions: [{ type: "set_crm_status", listingId: selection, status: "agreed" }], stopConversation: false });
    }) };
    const output = await runAgent(llm, logger, { systemPrompt: "prompt", history: [], batchText: "Вторая квартира",
      previousRaw, feedback: [{ reason: "multi_listing_scope_requires_manager" }], allowRepair: false });
    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(output.result.selectedListingId).toBe(202);
  });

  it.each([
    ["malformed JSON", "not json"],
    ["schema-invalid action", JSON.stringify({
      reply: "Thanks",
      actions: [{ type: "update_rental_terms", data: { price: 900, commission_type: "percentage" } }],
      stopConversation: false,
    })],
  ])("requests one repair, then rejects %s without salvaging or inventing a reply", async (_label, invalid) => {
    const llm = { complete: vi.fn().mockResolvedValue(invalid) };

    await expect(runAgent(llm, logger, {
      systemPrompt: "prompt",
      history: [],
      batchText: "Цена 900 долларов в месяц",
    })).rejects.toBeInstanceOf(AgentOutputError);

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(llm.complete.mock.calls[1][0].at(-1)?.content).toContain("Ошибка формата");
  });

  it("repairs a final-stage response that proposes actions and returns no repeated actions", async () => {
    const invalidFinal = JSON.stringify({
      reply: "Записал цену.",
      actions: [{ type: "update_rental_terms", data: { price: 900 } }],
      stopConversation: false,
    });
    const validFinal = JSON.stringify({ reply: "Цена записана, спасибо.", actions: [], stopConversation: false });
    const llm = { complete: vi.fn().mockResolvedValueOnce(invalidFinal).mockResolvedValueOnce(validFinal) };

    const output = await runAgent(llm, logger, {
      systemPrompt: "prompt",
      history: [],
      batchText: "Цена 900 долларов",
      executionResults: { results: [{ success: true }], crmAfter: [{ rental_terms: { price: 900 } }] },
    });

    expect(llm.complete).toHaveBeenCalledTimes(2);
    const finalCallMessages = llm.complete.mock.calls[0][0] as ChatMessage[];
    expect(finalCallMessages.some((message) => message.content.includes("CRM_EXECUTION_RESULTS"))).toBe(true);
    expect(output.result).toEqual({ reply: "Цена записана, спасибо.", actions: [], stopConversation: false });
  });
});
