import { describe, expect, it } from "vitest";
import { AgentResult } from "../../src/agent/schemas";
import { finalizeAgentResponse } from "../../src/conversation/conversation.service";
import { baseListing } from "../conversations/scenarios";

describe("transliterated input response contract", () => {
  it("keeps the model's transliterated-message facts without adding inferred fields", () => {
    const listing = structuredClone(baseListing);
    const result: AgentResult = {
      reply: "Spasibo, zapisala minimal'nyy srok.",
      actions: [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_rental_terms", data: { minimum_lease_months: 6 } },
      ],
      stopConversation: false,
    };
    const finalized = finalizeAgentResponse({
      result,
      phase: "primary",
      history: [{ role: "assistant", content: "Vy sobstvennik?" }],
      batchText: "Da, ia sobstvenik. Minimalni 6 mesiacev.",
      listings: [listing],
      primaryListing: listing,
    });

    expect(finalized.reply).toBe(result.reply);
    expect(finalized.gate.allowed).toEqual([
      result.actions[0],
      { ...result.actions[1], listingId: listing.id },
    ]);
    expect(finalized.gate.allowed.some(action => action.type === "set_crm_status")).toBe(false);
  });

  it("does not infer ownership or cooperation from a transliterated yes", () => {
    const listing = structuredClone(baseListing);
    const result: AgentResult = {
      reply: "Možete li pojasniti, da li ste vlasnik?",
      actions: [],
      stopConversation: false,
    };
    const finalized = finalizeAgentResponse({
      result,
      phase: "primary",
      history: [{ role: "assistant", content: "Vy gotovy sotrudnichat s agentstvom?" }],
      batchText: "daa",
      listings: [listing],
      primaryListing: listing,
    });

    expect(finalized.reply).toBe(result.reply);
    expect(finalized.gate.allowed).toEqual([]);
    expect(finalized.stopConversation).toBe(false);
  });
});
