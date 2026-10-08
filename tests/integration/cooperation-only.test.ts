import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { COOPERATION_QUESTION, cooperationDecision, asksWhichApartment, apartmentClarification } from "../../src/conversation/cooperation-only";

function harnessWithOutreach(question = COOPERATION_QUESTION) {
  const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only", TERMINAL_CRM_STATUSES: "" });
  const instanceId = h.config.instances[0].id;
  const phone = "+995555700090";
  h.crm.setContactState(phone, { status: "new", listings: [
    { id: 101, address: "Кобаладзе 12", url: "https://example.com/flat/101" },
    { id: 102, address: "Пиросмани 8", url: "https://example.com/flat/102" },
  ] as never });
  vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([
    { id: 1, direction: "outgoing", sender: null, instance_id: instanceId,
      sent_at: "2026-10-08T00:00:00Z", text: "Здравствуйте! " + question, notes: "cooperation_outreach:v1:101" },
  ]);
  return { h, phone, instanceId, message: (text: string) => h.makeMessage({ instanceId, chatId: phone.slice(1) + "@c.us", text }) };
}

describe("cooperation-only owner handoff", () => {
  it.each(["Какая квартира?", "Здравствуйте! Что за квартира?", "Какой адрес?", "Пришлите ссылку на объявление"])("answers %s with the original apartment, then accepts consent", async text => {
    const { h, phone, message } = harnessWithOutreach();
    await h.ingest(message(text));
    await h.scheduler.runAll();
    const outgoing = h.debug.snapshot().outgoing;
    expect(outgoing).toHaveLength(1);
    expect(outgoing[0].message).toContain("Кобаладзе 12");
    expect(outgoing[0].message).toContain("https://example.com/flat/101");
    expect(outgoing[0].message).not.toContain("Пиросмани");
    expect(outgoing[0].message).toContain(COOPERATION_QUESTION);
    expect((await h.crm.getListingsByPhone(phone))[0].crm_status).toBe("new");
    await h.ingest(message("да"));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone))[0].crm_status).toBe("agreed");
    expect(h.debug.snapshot().outgoing).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("uses the outreach marker even when the source is not the primary listing", async () => {
    const { h, instanceId, message } = harnessWithOutreach();
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([
      { id: 1, direction: "outgoing", sender: null, instance_id: instanceId, notes: "cooperation_outreach:v1:102",
        sent_at: "2026-10-08T00:00:00Z", text: COOPERATION_QUESTION },
    ]);
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing[0].message).toContain("https://example.com/flat/102");
    await h.ingest(message("да"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "agreed", { suppressTelegram: true, cooperationOnly: true });
  });

  it.each([undefined, "cooperation_outreach:v1:999"])("does not guess an apartment for an unresolved marker %s", async notes => {
    const { h, instanceId, message } = harnessWithOutreach();
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([
      { id: 1, direction: "outgoing", sender: null, instance_id: instanceId, notes,
        sent_at: "2026-10-08T00:00:00Z", text: COOPERATION_QUESTION },
    ]);
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("rechecks manager takeover before sending the apartment link", async () => {
    const { h, instanceId, message } = harnessWithOutreach();
    const rows = await h.services.crm.getInteractions("", instanceId);
    vi.mocked(h.services.crm.getInteractions).mockResolvedValueOnce(rows).mockResolvedValue([
      ...rows, { id: 2, direction: "outgoing", sender: "manager", instance_id: instanceId,
        sent_at: "2026-10-08T00:01:00Z", text: "Обсудим вручную" },
    ]);
    await h.ingest(message("Какая квартира?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("quarantines an uncertain clarification send and never repeats it", async () => {
    const { h, message } = harnessWithOutreach();
    const sender = vi.spyOn(h.services.sender, "sendMessage").mockRejectedValue(new Error("response lost"));
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("quarantines a history failure after a clarification without sending twice", async () => {
    const { h, message } = harnessWithOutreach();
    const append = h.store.appendHistory.bind(h.store);
    let failed = false;
    vi.spyOn(h.store, "appendHistory").mockImplementation(async (...args) => {
      if (args[1].role === "assistant" && !failed) {
        failed = true;
        throw new Error("history storage interrupted after send");
      }
      return append(...args);
    });
    await h.ingest(message("Какая квартира?"));
    const results = await h.scheduler.runAll();
    expect(results.at(-1)?.status).toBe("quarantined");
    await h.ingest(message("Пришлите ссылку"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing).toHaveLength(1);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("recovers a confirmed cooperation clarification intent after a process crash", async () => {
    const { h, instanceId, message } = harnessWithOutreach();
    const inbound = message("Какая квартира?");
    await h.ingest(inbound);
    const key = h.key(instanceId, inbound.chatId);
    await h.store.drainPending(key);
    const active = (await h.store.getActiveBatch(key))!;
    const reply = apartmentClarification({ id: 101, address: "Кобаладзе 12", url: "https://example.com/flat/101" });
    await h.store.saveAgentCheckpoint(key, active.batchKey, {
      mode: "cooperation_only", completedActions: 0, finalized: true, reply,
      result: { reply, stopConversation: false, actions: [], selectedListingId: 101 },
    });
    const intent = await h.store.prepareOutboundIntent({ conversationKey: key, batchKey: active.batchKey,
      instanceId, chatId: inbound.chatId, message: reply });
    await h.store.claimOutboundIntent(key, intent.intentId);
    await h.store.markOutboundSent(key, intent.intentId, "already-confirmed");
    const result = (await h.scheduler.runAll())[0];
    expect(result?.status).toBe("processed");
    expect(result?.reply).toBe(reply);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.llm.calls).toHaveLength(0);
  });

  it("can identify a single listing from old unmarked cooperation outreach", async () => {
    const { h, phone, instanceId, message } = harnessWithOutreach();
    h.crm.setContactState(phone, { status: "new", listings: [{ id: 101, address: "Кобаладзе 12" }] as never });
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([
      { id: 1, direction: "outgoing", sender: null, instance_id: instanceId,
        sent_at: "2026-10-08T00:00:00Z", text: COOPERATION_QUESTION },
    ]);
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing[0].message).toContain("Кобаладзе 12");
  });

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
  it("leaves compound business questions manual", () => {
    expect(asksWhichApartment("Какая квартира? Какая комиссия?")).toBe(false);
    expect(asksWhichApartment("Да, какая квартира?")).toBe(false);
    expect(apartmentClarification({ id: 1 })).toBe("");
    expect(apartmentClarification({ id: 1, url: "javascript:alert(1)" })).toBe("");
    expect(apartmentClarification({ id: 1, address: "Кобаладзе 12" })).toContain(COOPERATION_QUESTION);
  });
  it.each(["нет", "Нет, спасибо", "net", "no", "არა"])("recognizes %s", text => expect(cooperationDecision(text)).toBe("disagreed"));
  it("rejects negative/conditional tails instead of using a substring yes", () => {
    expect(cooperationDecision("да но нет" )).toBeNull();
    expect(cooperationDecision("да, не хочу" )).toBeNull();
  });
});
