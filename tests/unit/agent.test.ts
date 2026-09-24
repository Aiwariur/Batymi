import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent/agent";
import { Logger } from "../../src/observability/logger";

describe("agent structured-output recovery", () => {
  it("asks for clarification without running actions after two invalid replies", async () => {
    const llm = { complete: vi.fn().mockResolvedValue("not json") };
    const logger = {
      info: vi.fn(),
      warn: vi.fn(),
      error: vi.fn(),
    } as unknown as Logger;

    const { result } = await runAgent(llm, logger, {
      systemPrompt: "prompt",
      history: [],
      batchText: "Да, я собственник",
    });

    expect(llm.complete).toHaveBeenCalledTimes(2);
    expect(result.actions).toEqual([]);
    expect(result.stopConversation).toBe(false);
    expect(result.reply.toLowerCase()).toContain("уточните");
    expect(result.reply).toContain("?");
  });

  it("keeps valid rental facts while dropping an unsupported commission enum", async () => {
    const llm = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        reply: "Спасибо, уточните ещё пару деталей?",
        actions: [{
          type: "update_rental_terms",
          data: { price: 950, commission_type: "percentage", commission_payer: "owner" },
        }],
        stopConversation: false,
      })),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
    const { result } = await runAgent(llm, logger, {
      systemPrompt: "prompt",
      history: [],
      batchText: "Цена 950 долларов в месяц",
    });

    expect(llm.complete).toHaveBeenCalledTimes(1);
    expect(result.actions).toEqual([{ type: "update_rental_terms", data: { price: 950, commission_payer: "owner" } }]);
  });
});
