import { describe, expect, it } from "vitest";
import { finalizeAgentResponse } from "../../src/conversation/conversation.service";
import { baseListing } from "../conversations/scenarios";

describe("conversation response finalization", () => {
  it("preserves the model reply and does not infer facts or add CRM actions", () => {
    const listing = structuredClone(baseListing);
    const modelReply = "Вид на море. Уточните, пожалуйста, в каком ЖК квартира?";
    const finalized = finalizeAgentResponse({
      result: { reply: modelReply, actions: [], stopConversation: false },
      phase: "primary",
      history: [{ role: "assistant", content: "Какой вид из окон? В каком ЖК квартира?" }],
      batchText: "Вид на море",
      listings: [listing],
      primaryListing: listing,
    });

    expect(finalized.reply).toBe(modelReply);
    expect(finalized.gate.allowed).toEqual([]);
    expect(finalized.stopConversation).toBe(false);
  });

  it("passes a future availability note through without converting it to available or changing current CRM data", () => {
    const listing = structuredClone(baseListing);
    listing.rental_terms = {
      ...listing.rental_terms,
      availability_status: "available",
      lease_terms_notes: "Сдаётся долгосрочно",
    };
    const currentTerms = structuredClone(listing.rental_terms);
    const proposed = {
      type: "update_rental_terms" as const,
      data: { availability_status: "unknown" as const, lease_terms_notes: "Свободна с декабря" },
    };
    const finalized = finalizeAgentResponse({
      result: { reply: "Понял, сохраню, что квартира будет свободна с декабря.", actions: [proposed], stopConversation: false },
      phase: "agreed",
      history: [],
      batchText: "Свободна с декабря",
      listings: [listing],
      primaryListing: listing,
    });

    expect(finalized.gate.allowed).toEqual([{ ...proposed, listingId: listing.id }]);
    expect(finalized.reply).toBe("Понял, сохраню, что квартира будет свободна с декабря.");
    expect(finalized.gate.allowed.some(action => action.type === "update_rental_terms" && action.data.availability_status === "available")).toBe(false);
    expect(finalized.gate.allowed.some(action => action.type === "set_crm_status" && action.status === "qualified")).toBe(false);
    expect(listing.rental_terms).toEqual(currentTerms);
  });
});
