import { describe, expect, it, vi } from "vitest";
import { runAgent } from "../../src/agent/agent";
import { buildSystemPrompt, resolvePhase } from "../../src/agent/system-prompt";
import { Logger } from "../../src/observability/logger";
import { baseListing } from "../conversations/scenarios";

describe("owner dialogue prompt contract", () => {
  it("passes the actual listing snapshot and real history without exposing phone or inventing outreach", async () => {
    const listing = structuredClone(baseListing);
    const crm = { phone: listing.phone!, contact: null, listings: [listing] };
    const systemPrompt = buildSystemPrompt({
      crm,
      listings: crm.listings,
      primaryListing: listing,
      phase: resolvePhase(listing.crm_status),
    });
    const actualFirstMessage = "Добрый день. Квартира ещё сдаётся на долгосрочный срок?";
    const llm = {
      complete: vi.fn().mockResolvedValue(JSON.stringify({
        reply: "Спасибо. Вы собственник этой квартиры?",
        actions: [],
        stopConversation: false,
      })),
    };
    const logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;

    await runAgent(llm, logger, {
      systemPrompt,
      history: [{ role: "assistant", content: actualFirstMessage, ts: Date.now() }],
      batchText: "Да, актуально",
    });

    const messages = llm.complete.mock.calls[0][0];
    expect(messages[0].content).toContain("максимум пять пунктов");
    expect(messages[0].content).toContain("Не выдумывай первую рассылку");
    expect(messages[0].content).toContain("необязательны");
    expect(messages[0].content).toContain('"price":900');
    expect(messages[0].content).not.toContain(listing.phone!);
    expect(messages[0].content).not.toContain("CRM_API_KEY");
    expect(messages[0].content).not.toContain("Здравствуйте! Пишу по вашему объявлению");
    expect(messages[1]).toEqual({ role: "assistant", content: actualFirstMessage });
    expect(messages.at(-1)).toEqual({ role: "user", content: "Да, актуально" });
  });
});
