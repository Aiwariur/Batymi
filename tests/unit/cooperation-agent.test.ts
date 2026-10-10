import { describe, expect, it, vi } from "vitest";
import { LlmProvider } from "../../src/agent/llm.provider";
import { CrmInteraction } from "../../src/crm/crm.client";
import { COOPERATION_QUESTION, planCooperation } from "../../src/conversation/cooperation-agent";
import { HistoryEntry, Listing } from "../../src/types";

const instanceId = "instance-test";
const listings: Listing[] = [
  { id: 401, address: "Первый адрес", url: "https://example.com/flat/401" },
  { id: 402, address: "Второй адрес", url: "https://example.com/flat/402" },
];
const outreach = (listingId = 402, text = COOPERATION_QUESTION): CrmInteraction => ({
  id: 1, direction: "outgoing", sender: "phone", instance_id: instanceId,
  sent_at: "2026-10-10T10:00:00Z", text, notes: `cooperation_outreach:v1:${listingId}`,
});
const llmMustNotRun: LlmProvider = {
  complete: vi.fn(async () => { throw new Error("LLM must not be called for a deterministic short answer"); }),
};

describe("planCooperation short answers", () => {
  it.each([
    ["Да", "Готовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?"],
    ["Нет", "Готовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?"],
  ])("does not treat bare %s as an answer to the two initial questions", async (answer, followUp) => {
    const provider = { ...llmMustNotRun, complete: vi.fn(llmMustNotRun.complete) };
    const result = await planCooperation(provider, {
      history: [], batchText: answer,
      listings, interactions: [outreach(402, "Здравствуйте! Квартира актуальна? Готовы сотрудничать?" )], instanceId,
    });

    expect(result).toMatchObject({ reply: followUp, stopConversation: false, actions: [], selectedListingId: 402 });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it.each([
    ["yes", "Are you willing to work with our agency to rent out this apartment long-term?", "agreed"],
    ["დიახ", "მზად ხართ ჩვენს სააგენტოსთან თანამშრომლობისთვის ამ ბინის გრძელვადიანად გასაქირავებლად?", "agreed"],
    ["no", "Are you willing to work with our agency to rent out this apartment long-term?", "disagreed"],
    ["არა", "მზად ხართ ჩვენს სააგენტოსთან თანამშრომლობისთვის ამ ბინის გრძელვადიანად გასაქირავებლად?", "disagreed"],
  ] as const)("applies short %s after the single cooperation question without an LLM", async (answer, lastQuestion, status) => {
    const provider = { ...llmMustNotRun, complete: vi.fn(llmMustNotRun.complete) };
    const result = await planCooperation(provider, {
      history: [{ role: "assistant", content: lastQuestion, ts: 1 }], batchText: answer,
      listings, interactions: [outreach(402)], instanceId,
    });

    expect(result).toMatchObject({
      actions: [{ type: "set_crm_status", listingId: 402, status }],
      selectedListingId: 402, reply: "", stopConversation: true,
    });
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("uses the marker-selected listing among multiple objects when handling a bare yes", async () => {
    const provider = { ...llmMustNotRun, complete: vi.fn(llmMustNotRun.complete) };
    const result = await planCooperation(provider, {
      history: [{ role: "assistant", content: "Are you willing to work with our agency to rent out this apartment long-term?", ts: 1 }],
      batchText: "yes", listings, interactions: [outreach(402)], instanceId,
    });

    expect(result.actions).toEqual([{ type: "set_crm_status", listingId: 402, status: "agreed" }]);
    expect(provider.complete).not.toHaveBeenCalled();
  });

  it("does not apply a short answer when the outreach marker points outside the CRM listings", async () => {
    const provider: LlmProvider = {
      complete: vi.fn(async () => JSON.stringify({ intent: "consent", language: "en", evidence: "yes" })),
    };
    const result = await planCooperation(provider, {
      history: [{ role: "assistant", content: "Are you willing to work with our agency to rent out this apartment long-term?", ts: 1 }],
      batchText: "yes", listings, interactions: [outreach(999)], instanceId,
    });

    expect(result.actions).toEqual([]);
    expect(result).toMatchObject({ reply: "Please clarify which apartment you mean by sending its address or listing link.", stopConversation: false });
    expect(provider.complete).toHaveBeenCalledTimes(1);
  });
});
