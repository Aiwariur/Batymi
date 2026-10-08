import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { COOPERATION_QUESTION, cooperationDecision } from "../../src/conversation/cooperation-only";

function harnessWithOutreach(question = COOPERATION_QUESTION) {
  const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only", TERMINAL_CRM_STATUSES: "" });
  const instanceId = h.config.instances[0].id;
  const phone = "+995555700090";
  h.crm.setContactState(phone, { status: "new", listings: [{ id: 101 }, { id: 102 }] as never });
  vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([
    { id: 1, direction: "outgoing", sender: null, instance_id: instanceId,
      sent_at: "2026-10-08T00:00:00Z", text: "Здравствуйте! " + question },
  ]);
  return { h, phone, instanceId, message: (text: string) => h.makeMessage({ instanceId, chatId: phone.slice(1) + "@c.us", text }) };
}

describe("cooperation-only owner handoff", () => {
  it.each(["Да", "Здравствуйте! Да, согласен", "da", "yes", "კი"])("persists consent %s contact-wide and never replies", async text => {
    const { h, phone, message } = harnessWithOutreach();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    await h.ingest(message(text));
    expect((await h.scheduler.runAll())[0]?.stopConversation).toBe(true);
    expect(setStatus).toHaveBeenCalledWith(101, "agreed", { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).map(listing => listing.crm_status)).toEqual(["agreed", "agreed"]);
    await h.ingest(message("Какая комиссия?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(1);
  });

  it("handles greeting and refusal in separate batched messages without inventing rented", async () => {
    const { h, phone, message } = harnessWithOutreach();
    await h.ingest(message("dobri den"));
    await h.ingest(message("net"));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone))[0].crm_status).toBe("disagreed");
    await h.ingest(message("spasibo"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.debug.snapshot().crmActions).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it.each(["Да, но только без комиссии", "Да?", "Да\nнет", "Какая комиссия?", "Квартира актуальна, но сотрудничать не хочу", "Сдаётся с декабря"])("leaves %s to a human", async text => {
    const { h, phone, message } = harnessWithOutreach();
    await h.ingest(message(text));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone))[0].crm_status).toBe("new");
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("never treats yes to old availability-only outreach as cooperation consent", async () => {
    const { h, message } = harnessWithOutreach("Квартира ещё сдаётся?");
    await h.ingest(message("да"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("does not interpret a yes batched with audio as unconditional consent", async () => {
    const { h, message } = harnessWithOutreach();
    const transcribe = vi.spyOn(h.services.transcription, "transcribe");
    await h.ingest(message("да"));
    await h.ingest({ ...message(""), type: "audio", fileUrl: "https://example.test/audio" });
    await h.scheduler.runAll();
    expect(transcribe).not.toHaveBeenCalled();
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("respects manual takeover before consent", async () => {
    const { h, instanceId, message } = harnessWithOutreach();
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([
      { id: 1, direction: "outgoing", sender: "manager", instance_id: instanceId,
        sent_at: "2026-10-08T00:00:00Z", text: COOPERATION_QUESTION },
    ]);
    await h.ingest(message("да"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("cancels a qualification checkpoint prepared before the mode switch", async () => {
    const { h, instanceId, message } = harnessWithOutreach();
    const inbound = message("да");
    await h.ingest(inbound);
    const key = h.key(instanceId, inbound.chatId);
    await h.store.drainPending(key);
    const active = (await h.store.getActiveBatch(key))!;
    await h.store.saveAgentCheckpoint(key, active.batchKey, {
      result: { reply: "Какой депозит?", stopConversation: false, actions: [] },
      completedActions: 0, finalized: true, reply: "Какой депозит?",
    });
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("retries a lost CRM response using the same decision with no model or WhatsApp send", async () => {
    const { h, phone, message } = harnessWithOutreach();
    const original = h.crm.setStatus.bind(h.crm);
    let calls = 0;
    vi.spyOn(h.services.crm, "setStatus").mockImplementation(async (...args) => {
      await original(...args);
      if (++calls === 1) throw new Error("response lost after commit");
    });
    await h.ingest(message("да"));
    await h.scheduler.runAll();
    expect(calls).toBe(2);
    expect((await h.crm.getListingsByPhone(phone))[0].crm_status).toBe("agreed");
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
});

describe("conservative reply vocabulary", () => {
  it.each(["нет", "Нет, спасибо", "net", "no", "არა"])("recognizes %s", text => expect(cooperationDecision(text)).toBe("disagreed"));
  it("rejects negative/conditional tails instead of using a substring yes", () => {
    expect(cooperationDecision("да но нет" )).toBeNull();
    expect(cooperationDecision("да, не хочу" )).toBeNull();
  });
});
