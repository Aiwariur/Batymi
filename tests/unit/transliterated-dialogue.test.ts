import { describe, expect, it } from "vitest";
import { finalizeAgentResponse } from "../../src/conversation/conversation.service";
import { AgentResult } from "../../src/agent/schemas";
import { baseListing } from "../conversations/scenarios";
import { applyActions } from "../conversations/evaluate";

describe("fragmented transliterated owner dialogue", () => {
  it("keeps semantic model facts, asks what remains, and never replies with a receipt only", () => {
    const listing = structuredClone(baseListing);
    const history: { role: "user" | "assistant"; content: string }[] = [
      { role: "user", content: "Da aktualno" },
      { role: "assistant", content: "Вы собственник? Какая цена в месяц, депозит и минимальный срок?" },
    ];
    const turns: { user: string; result: AgentResult }[] = [
      { user: "Da ia sobstvenik, ia lana", result: {
        reply: "Принял, Лана!", actions: [{ type: "set_contact_type", contactType: "owner" }], stopConversation: false,
      } },
      { user: "800$", result: {
        reply: "Записал цену 800$.", actions: [{ type: "update_rental_terms", data: { price: 800, currency: "USD" } }], stopConversation: false,
      } },
      { user: "Minimalni 6 mesiacev", result: {
        reply: "Записал минимальный срок 6 месяцев.", actions: [{ type: "update_rental_terms", data: { minimum_lease_months: 6 } }], stopConversation: false,
      } },
    ];
    for (const turn of turns) {
      const guarded = finalizeAgentResponse({ result: turn.result, phase: "primary", history,
        batchText: turn.user, listings: [listing], primaryListing: listing });
      applyActions(listing, guarded.gate.allowed);
      expect(guarded.reply).toMatch(/сотрудничать/);
      expect(guarded.reply).toContain("?");
      expect(guarded.reply).not.toMatch(/принял|записал|вы собственник/i);
      expect(guarded.stopConversation).toBe(false);
      expect(listing.crm_status).toBe("delivered");
      history.push({ role: "user", content: turn.user }, { role: "assistant", content: guarded.reply });
    }
    expect(listing.contact_type).toBe("owner");
    expect(listing.rental_terms).toMatchObject({ price: 800, currency: "USD", minimum_lease_months: 6 });
  });
});
