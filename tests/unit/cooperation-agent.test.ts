import { describe, expect, it, vi } from "vitest";
import { ChatMessage, LlmProvider } from "../../src/agent/llm.provider";
import { AgentOutputError } from "../../src/agent/agent";
import { CrmInteraction } from "../../src/crm/crm.client";
import {
  COOPERATION_PLANNER_VERSION,
  COOPERATION_QUESTION,
  planCooperation,
} from "../../src/conversation/cooperation-agent";
import { HistoryEntry, Listing } from "../../src/types";

const instanceId = "instance-test";
const listings: Listing[] = [
  { id: 401, address: "Первый адрес", url: "https://example.com/flat/401" },
  { id: 402, address: "Второй адрес", url: "https://example.com/flat/402", description: "Светлая двушка у моря" },
];
const outreach = (listingId = 402, text = COOPERATION_QUESTION): CrmInteraction => ({
  id: 1, direction: "outgoing", sender: "phone", instance_id: instanceId,
  sent_at: "2026-10-10T10:00:00Z", text, notes: `cooperation_outreach:v1:${listingId}`,
});
const decision = (d: Record<string, unknown>) => JSON.stringify(d);
const replyDecision = (reply: string, extra: Record<string, unknown> = {}) =>
  decision({ action: "reply", reply, language: "ru", crm_status: null, reason: "тестовая реплика по делу", ...extra });
const handoffDecision = (crm_status: string | null, reason = "тестовая передача менеджеру", listing_scope = "source") =>
  decision({ action: "handoff", reply: "", language: "ru", crm_status, listing_scope, reason });
const stopDecision = (crm_status: string, reason = "тестовое завершение диалога", listing_scope = "source") =>
  decision({ action: "stop", reply: "", language: "ru", crm_status, listing_scope, reason });

interface RecordedCall { messages: ChatMessage[]; opts?: { temperature?: number; maxTokens?: number } }
function script(responses: string[]) {
  const calls: RecordedCall[] = [];
  let index = 0;
  const provider: LlmProvider = {
    complete: vi.fn(async (messages: ChatMessage[], opts?: { temperature?: number; maxTokens?: number }) => {
      calls.push({ messages, opts });
      const raw = responses[Math.min(index, responses.length - 1)];
      index += 1;
      return raw;
    }),
  };
  return { provider, calls };
}
const systemPrompt = (calls: RecordedCall[]) => calls[0].messages[0].content;
const userContent = (calls: RecordedCall[]) => calls[0].messages[calls[0].messages.length - 1].content;

describe("planCooperation owner-dialogue adapter", () => {
  it("uses owner_dialogue_v2 so saved v1 checkpoints are replanned", () => {
    expect(COOPERATION_PLANNER_VERSION).toBe("owner_dialogue_v2");
  });

  it("always asks the model for a bare yes — no keyword short-circuit", async () => {
    const { provider, calls } = script([handoffDecision("agreed", "да на вопрос о сотрудничестве")]);
    const history: HistoryEntry[] = [{ role: "assistant", content: COOPERATION_QUESTION, ts: 1 }];
    const result = await planCooperation(provider, {
      history, batchText: "да", listings: [listings[1]], contactListingCount: 1, interactions: [outreach(402)], instanceId,
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      actions: [{ type: "set_crm_status", listingId: 402, status: "agreed" }],
      selectedListingId: 402, reply: "", stopConversation: true,
    });
    expect(result.handoffReason ?? "").toContain("сотрудничестве");
    expect(userContent(calls)).toContain("[Собственник] да");
  });

  it("passes the model reply verbatim with dialogue facts in the prompt", async () => {
    const reply = "Добрый день! Пишу по квартире на Второй адрес — уточню: она ещё актуальна?";
    const { provider, calls } = script([replyDecision(reply)]);
    const result = await planCooperation(provider, {
      history: [], batchText: "Здравствуите", listings, interactions: [outreach(402)], instanceId,
      representativeName: "Пётр", agencyName: "Batumi Key",
    });
    expect(result).toMatchObject({ reply, actions: [], stopConversation: false, selectedListingId: 402 });
    expect(systemPrompt(calls)).toContain("Batumi Key");
    expect(systemPrompt(calls)).toContain("Пётр");
    expect(systemPrompt(calls)).toContain("Второй адрес");
    expect(systemPrompt(calls)).toContain("https://example.com/flat/402");
    expect(systemPrompt(calls)).toContain("Светлая двушка у моря");
    expect(systemPrompt(calls)).toContain("Конкретного клиента на эту квартиру сейчас нет");
    expect(systemPrompt(calls)).toContain("listing_scope");
    expect(userContent(calls)).toContain("[Собственник] Здравствуите");
  });

  it("maps a silent handoff without CRM status for a commission question", async () => {
    const { provider } = script([handoffDecision(null, "спросил комиссию — передаю менеджеру")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "Сколько берёте за услуги?", listings, interactions: [outreach(402)], instanceId,
    });
    expect(result).toMatchObject({ reply: "", stopConversation: true, actions: [] });
    expect(result.handoffReason ?? "").toContain("комиссию");
  });

  it.each([
    ["disagreed", "попросил больше не писать"],
    ["listing_removed", "квартира уже сдана"],
    ["realtor", "собеседник оказался риелтором"],
  ] as const)("maps stop with reason %s to a silent terminal status", async (status, reason) => {
    const { provider } = script([stopDecision(status, reason)]);
    const result = await planCooperation(provider, {
      history: [], batchText: "текст реплики собственника", listings: [listings[1]], contactListingCount: 1, interactions: [outreach(402)], instanceId,
    });
    expect(result).toMatchObject({
      actions: [{ type: "set_crm_status", listingId: 402, status }],
      reply: "", stopConversation: true,
    });
    expect(result.handoffReason).toBeUndefined();
  });

  it("keeps silence as a no-op that leaves the conversation open", async () => {
    const { provider } = script([decision({ action: "silence", reply: "", language: "ru", crm_status: null, reason: "поблагодарил и попрощался" })]);
    const result = await planCooperation(provider, {
      history: [], batchText: "Спасибо, всего доброго", listings, interactions: [outreach(402)], instanceId,
    });
    expect(result).toMatchObject({ reply: "", actions: [], stopConversation: false });
  });

  it("runs a repair round when the model repeats an already sent text", async () => {
    const repeated = "Уточните, пожалуйста, адрес квартиры";
    const fixed = "Понял вас! Пишу про Второй адрес — актуальна ли квартира сейчас?";
    const { provider, calls } = script([replyDecision(repeated), replyDecision(fixed)]);
    const history: HistoryEntry[] = [{ role: "assistant", content: repeated, ts: 1 }];
    const result = await planCooperation(provider, {
      history, batchText: "не понял о какой квартире речь", listings, interactions: [outreach(402)], instanceId,
    });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe(fixed);
    expect(calls[1].messages.some(m => m.role === "system" && m.content.includes("уже отправлялся"))).toBe(true);
  });

  it("forbids agreed for a bare commission question and repairs to a null status", async () => {
    const { provider } = script([handoffDecision("agreed", "спросил про комиссию"), handoffDecision(null, "вопрос о комиссии — менеджеру")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "Сколько берёте за услуги?", listings, interactions: [outreach(402)], instanceId,
    });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.actions).toEqual([]);
    expect(result).toMatchObject({ reply: "", stopConversation: true });
  });

  it("quarantines with AgentOutputError after three invalid model outputs", async () => {
    const { provider } = script(["мусор", "{broken", decision({ action: "reply", reply: "", language: "ru", crm_status: null, reason: "пустой ответ" })]);
    await expect(planCooperation(provider, {
      history: [], batchText: "Добрый день", listings, interactions: [outreach(402)], instanceId,
    })).rejects.toBeInstanceOf(AgentOutputError);
    expect(provider.complete).toHaveBeenCalledTimes(3);
  });

  it("does not leak internal CRM urls into the prompt", async () => {
    const internal: Listing[] = [{ id: 402, address: "Второй адрес", url: "https://admin.batumi-key.homes/flat/402" }];
    const { provider, calls } = script([replyDecision("Пишу по Второму адресу — квартира ещё сдаётся?")]);
    await planCooperation(provider, {
      history: [], batchText: "добрый день", listings: internal, interactions: [outreach(402)], instanceId,
    });
    expect(systemPrompt(calls)).not.toContain("admin.batumi-key.homes");
    expect(systemPrompt(calls)).toContain("Второй адрес");
  });

  it("routes a stop reason to a manual handoff when no listing can be identified", async () => {
    const { provider } = script([stopDecision("disagreed", "отказ без идентифицируемого объекта")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "не актуально", listings: [listings[1]], contactListingCount: 1, interactions: [outreach(999)], instanceId,
    });
    expect(result.actions).toEqual([]);
    expect(result).toMatchObject({ reply: "", stopConversation: true });
    expect(result.handoffReason ?? "").toContain("listing_scope_review");
  });

  it("repairs a reply that leaks the manager/colleague handoff wording", async () => {
    const leaky = "Если готовы показать квартиру, передаю коллеге — он свяжется с вами по времени.";
    const clean = "Хорошо, больше не пишу. Если решите сдать квартиру — напишите здесь.";
    const { provider } = script([replyDecision(leaky), replyDecision(clean)]);
    const result = await planCooperation(provider, {
      history: [{ role: "assistant", content: "Уточните, пожалуйста, кто вы", ts: 1 }],
      batchText: "не пишите мне больше", listings, interactions: [outreach(402)], instanceId,
    });
    expect(provider.complete).toHaveBeenCalledTimes(2);
    expect(result.reply).toBe(clean);
  });

  it("calls the planner without json mode and with a reasoning-safe token budget", async () => {
    const { provider, calls } = script([replyDecision("Квартира ещё актуальна? Подскажите, пожалуйста.")]);
    await planCooperation(provider, {
      history: [], batchText: "здравствуйте", listings, interactions: [outreach(402)], instanceId,
    });
    expect(provider.complete).toHaveBeenCalledTimes(1);
    expect(calls[0].opts).toMatchObject({ temperature: 0.3, maxTokens: 2000, jsonMode: false });
  });

  it.each(["agreed", "disagreed", "listing_removed"] as const)(
    "requires a single contact listing before applying source status %s",
    async (status) => {
      const raw = status === "agreed"
        ? handoffDecision(status, "подтвержден исходный объект", "source")
        : stopDecision(status, "подтвержден исходный объект", "source");
      const { provider } = script([raw]);
      const result = await planCooperation(provider, {
        history: [], batchText: "ответ по объявлению", listings: [listings[1]], contactListingCount: 2,
        interactions: [outreach(402)], instanceId,
      });
      expect(result.actions).toEqual([]);
      expect(result.handoffReason).toContain("listing_scope_review");
      expect(result.stopConversation).toBe(true);
    },
  );

  it("uses the full contact listing count even when only one listing was passed to the planner", async () => {
    const { provider } = script([handoffDecision("agreed", "согласие по исходному объявлению", "source")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "да", listings: [listings[1]], contactListingCount: 2,
      interactions: [outreach(402)], instanceId,
    });
    expect(result.actions).toEqual([]);
    expect(result.handoffReason).toContain("listing_scope_review");
  });

  it("applies a source status when the contact has exactly one listing", async () => {
    const { provider } = script([handoffDecision("agreed", "согласие по исходному объявлению", "source")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "да", listings: [listings[1]], contactListingCount: 1,
      interactions: [outreach(402)], instanceId,
    });
    expect(result.actions).toEqual([{ type: "set_crm_status", listingId: 402, status: "agreed" }]);
  });

  it.each([
    ["other", decision({ action: "stop", reply: "", language: "ru", crm_status: "listing_removed", listing_scope: "other", reason: "другая квартира уже сдана" })],
    ["missing", decision({ action: "stop", reply: "", language: "ru", crm_status: "listing_removed", reason: "статус без scope" })],
    ["unknown", decision({ action: "stop", reply: "", language: "ru", crm_status: "listing_removed", listing_scope: "unknown", reason: "неясно, о какой квартире речь" })],
  ] as const)("sends %s object scope to manager review without a status write", async (_scope, raw) => {
    const { provider } = script([raw]);
    const result = await planCooperation(provider, {
      history: [], batchText: "уже сдана", listings: [listings[1]], contactListingCount: 1,
      interactions: [outreach(402)], instanceId,
    });
    expect(result.actions).toEqual([]);
    expect(result.handoffReason).toContain("listing_scope_review");
  });

  it("keeps realtor status contact-wide when multiple listings exist", async () => {
    const { provider } = script([stopDecision("realtor", "собеседник риелтор", "other")]);
    const result = await planCooperation(provider, {
      history: [], batchText: "я риелтор", listings, contactListingCount: 2,
      interactions: [outreach(402)], instanceId,
    });
    expect(result.actions).toEqual([{ type: "set_crm_status", listingId: 402, status: "realtor" }]);
  });
});
