import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { COOPERATION_QUESTION } from "../../src/conversation/cooperation-agent";
import { normalizeGreenApiWebhook } from "../../src/webhooks/greenapi.normalizer";
import { GreenApiWebhookPayload } from "../../src/greenapi/greenapi.schemas";

function setup() {
  const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only" });
  const instanceId = h.config.instances[0].id, phone = "+995555700090";
  h.crm.setContactState(phone, { status: "new", listings: [
    { id: 101, address: "Кобаладзе 12" }, { id: 102, address: "Лермонтова 31" },
  ] as never });
  vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([
    { id: 1, direction: "outgoing", sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:41:35Z", text: "Здравствуйте! Квартира по адресу: Лермонтова 31. " + COOPERATION_QUESTION },
  ]);
  return { h, instanceId, phone, message: (text: string) => h.makeMessage({ instanceId, chatId: phone.slice(1) + "@c.us", text }) };
}
const proposal = (reply = "", status?: "agreed" | "disagreed" | "listing_removed") => JSON.stringify({ reply,
  selectedListingId: 102, stopConversation: !!status,
  actions: status ? [{ type: "set_crm_status", listingId: 102, status }] : [] });

describe("LLM cooperation handoff execution", () => {
  it("repairs a silent nonterminal model result into an owner clarification", async () => {
    const { h, message } = setup();
    const reply = "Пишу по этой квартире: https://example.com/flat/102. Готовы сотрудничать?";
    h.llm.responder = () => h.llm.calls.length === 1 ? proposal("") : proposal(reply);
    await h.ingest(message("Какая именно квартира?"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "processed", reply });
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it.each([
    ["identity", "Are you ai?", "Yes, I'm an AI assistant. A manager will contact you. Ready to cooperate?"],
    ["terms", "So contract will be around 6 months possibly extending", "Условия сотрудничества обсудит менеджер."],
  ])("silences %s handoff and future messages without changing CRM status", async (reason, text, leakedReply) => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    h.llm.responder = () => JSON.stringify({ reply: leakedReply, actions: [], stopConversation: false, handoffReason: reason });
    await h.ingest(message(text));
    const first = (await h.scheduler.runAll())[0];
    expect(first).toMatchObject({ status: "processed", reply: "", stopConversation: true });
    expect(await h.store.getManualHandoff(key)).toBe(reason);
    expect(await h.store.getActiveBatch(key)).toBeNull();
    await h.ingest(message("Какая квартира?"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "skipped", stopConversation: true });
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "new")).toBe(true);
    expect((await h.store.getHistory(key, 20)).map(row => row.content)).toContain("Какая квартира?");
    expect(await h.store.pendingCount(key)).toBe(0);
  });
  it("uses the receiving line's representative name for a normal introduction", async () => {
    const { h, instanceId, message } = setup();
    h.config.instances[0].name = "Александр";
    h.llm.responder = messages => {
      expect(messages[0].content).toContain('"representativeName":"Александр"');
      return proposal("Александр, представляю агентство долгосрочной аренды.");
    };
    await h.ingest(message("Кто мне пишет?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual(["Александр, представляю агентство долгосрочной аренды."]);
  });
  it("recovers a saved handoff without asking the model again after a storage failure", async () => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    h.llm.responder = () => JSON.stringify({ reply: "", actions: [], stopConversation: true, handoffReason: "identity" });
    const handoff = h.store.handoffToManager.bind(h.store);
    const failOnce = vi.spyOn(h.store, "handoffToManager").mockRejectedValueOnce(Error("Redis temporarily unavailable"))
      .mockImplementation(handoff);
    await h.ingest(message("Are you ai?"));
    await h.scheduler.runAll();
    expect(failOnce).toHaveBeenCalledTimes(2);
    expect(h.llm.calls).toHaveLength(1);
    expect(await h.store.getManualHandoff(key)).toBe("identity");
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each([false, true])("transcribes cooperation audio and preserves accompanying text (mixed=%s)", async mixed => {
    const { h, message } = setup();
    const fileUrl = "https://greenapi.example/owner.ogg";
    const transcribe = vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Какая квартира вас интересует?");
    const reply = "Квартира на Лермонтова 31. Готовы сотрудничать?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe(mixed
        ? "Здравствуйте\nКакая квартира вас интересует?" : "Какая квартира вас интересует?");
      return proposal(reply);
    };
    if (mixed) await h.ingest(message("Здравствуйте"));
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl });
    await h.scheduler.runAll();
    expect(transcribe).toHaveBeenCalledWith(fileUrl);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
  });
  it("applies consent from an audio transcript silently", async () => {
    const { h, phone, message } = setup();
    vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Да, квартира актуальна, согласен сотрудничать");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toContain("согласен сотрудничать");
      return proposal("", "agreed");
    };
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl: "https://greenapi.example/yes.ogg" });
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "agreed")).toBe(true);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each([
    ["agreed", "Да, готов сотрудничать"],
    ["disagreed", "Нет, сотрудничать не готов"],
  ] as const)("uses quoted owner reply text for %s and stops after the terminal decision", async (status, answer) => {
    const { h, instanceId, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const clarification = "Какой адрес квартиры?";
    const quoted = normalizeGreenApiWebhook(instanceId, {
      typeWebhook: "incomingMessageReceived",
      idMessage: `quoted-${status}`,
      senderData: { chatId: phone.slice(1) + "@c.us" },
      messageData: {
        typeMessage: "quotedMessage",
        extendedTextMessageData: { text: clarification },
        quotedMessage: { idMessage: "original-cooperation-question", textMessage: COOPERATION_QUESTION },
      },
    } as GreenApiWebhookPayload);
    expect(quoted).toMatchObject({ type: "text", text: clarification, rawType: "quotedMessage" });

    const reply = "Квартира по адресу Лермонтова 31.";
    h.llm.responder = messages => {
      const lastUser = messages.filter(row => row.role === "user").at(-1)?.content;
      if (lastUser === clarification) {
        expect(lastUser).not.toContain(COOPERATION_QUESTION);
        return proposal(reply);
      }
      expect(lastUser).toBe(answer);
      expect(messages.some(row => row.content.includes("original-cooperation-question"))).toBe(false);
      expect(messages.some(row => row.content.includes(COOPERATION_QUESTION))).toBe(true);
      return proposal("", status);
    };
    await h.ingest(quoted!);
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);

    await h.ingest(message(answer));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === status)).toBe(true);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(102, status, { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);

    await h.ingest(message("Продолжим разговор?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
  it("sends the model's apartment answer for the actual transliterated message without a dictionary", async () => {
    const { h, message } = setup();
    const reply = "Interesuet kvartira na Lermontova 31: https://example.com/flat/102. Gotovy sotrudnichat?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("Kakaia kvartira vas interesuit");
      expect(messages[0].content).toContain("Лермонтова 31");
      return proposal(reply);
    };
    await h.ingest(message("Kakaia kvartira vas interesuit"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing[0].message).toBe(reply);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it.each(["agreed", "disagreed", "listing_removed"] as const)("executes model decision %s silently and stops future replies", async status => {
    const { h, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = () => proposal("thanks", status);
    await h.ingest(message("Произвольная фраза: решение принимает модель"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, status, { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === status)).toBe(true);
    await h.ingest(message("Какая квартира?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("closes an already rented apartment as listing_removed, not refusal", async () => {
    const { h, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages[0].content).toContain("недоступность объекта не означает отказ собственника сотрудничать");
      expect(messages.at(-1)?.content).toBe("здравствуйте уже сдала");
      return proposal("", "listing_removed");
    };
    await h.ingest(message("здравствуйте уже сдала"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "listing_removed", { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("persists the model decision once across a lost CRM response", async () => {
    const { h, message } = setup();
    h.llm.responder = () => proposal("", "agreed");
    const original = h.crm.setStatus.bind(h.crm);
    let attempts = 0;
    vi.spyOn(h.services.crm, "setStatus").mockImplementation(async (...args) => {
      await original(...args);
      if (++attempts === 1) throw Error("response lost after commit");
    });
    await h.ingest(message("Согласие своими словами"));
    await h.scheduler.runAll();
    expect(attempts).toBe(2);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("hands explicit commission conditions to a manager without forcing a CRM status", async () => {
    const { h, message } = setup();
    h.llm.responder = () => JSON.stringify({ reply: "", actions: [], stopConversation: true, handoffReason: "terms" });
    await h.ingest(message("Да, но без комиссии"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", reply: "", stopConversation: true });
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("answers a plain rental-duration statement with the apartment and cooperation question", async () => {
    const { h, message } = setup();
    const reply = "Квартира на Лермонтова 31: https://example.com/flat/102. Готовы сотрудничать?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("Сдаю до октября");
      return proposal(reply);
    };
    await h.ingest(message("Сдаю до октября"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", stopConversation: false });
    expect(await h.store.getManualHandoff(h.key(h.config.instances[0].id, "995555700090@c.us"))).toBeNull();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("excludes a model-recognized Georgian realtor across all listings without selecting an apartment", async () => {
    const { h, phone, message } = setup();
    const farewell = "მადლობა ინტერესისთვის, ჩვენ ვთანამშრომლობთ პირდაპირ მესაკუთრეებთან.";
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50");
      return JSON.stringify({ reply: farewell, actions: [{ type: "set_crm_status", status: "realtor" }], stopConversation: true });
    };
    await h.ingest(message("გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(101, "realtor", { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "realtor")).toBe(true);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([farewell]);
    await h.ingest(message("Продолжим сотрудничество?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(1);
  });
  it("does not exclude a Telegram partner", async () => {
    const { h, phone, message } = setup();
    h.crm.setContactState(phone, { contactType: "partner", listings: [{ id: 101 }, { id: 102 }] as never });
    h.llm.responder = () => JSON.stringify({ reply: "", actions: [{ type: "set_crm_status", status: "realtor" }], stopConversation: true });
    await h.ingest(message("Я агент, давайте 50/50"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each(["qualified", "update_rental_terms", "unknown_listing", "invented_link"])("rejects model output %s without any writes or sends", async kind => {
    const { h, message } = setup();
    h.llm.responder = () => kind === "qualified" ? proposal("", "agreed").replace("agreed", "qualified")
      : kind === "update_rental_terms" ? JSON.stringify({ reply: "saved", stopConversation: false, actions: [{ type: kind, listingId: 102, data: { price: 500 } }] })
      : kind === "unknown_listing" ? proposal("", "agreed").replaceAll("102", "999")
      : proposal("Ссылка: https://invented.invalid/flat/102");
    await h.ingest(message("Любой вопрос"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("quarantined");
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("rechecks manager takeover after the model returns", async () => {
    const { h, instanceId, message } = setup();
    const rows = await h.services.crm.getInteractions("", instanceId);
    vi.mocked(h.services.crm.getInteractions).mockResolvedValueOnce(rows).mockResolvedValue([...rows,
      { id: 2, direction: "outgoing", sender: "manager", instance_id: instanceId, text: "Отвечу вручную", sent_at: "2026-10-09T07:43:00Z" }]);
    h.llm.responder = () => proposal("Квартира на Лермонтова 31");
    await h.ingest(message("Что за квартира?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("quarantines an uncertain send without running the model or sender again", async () => {
    const { h, message } = setup();
    h.llm.responder = () => proposal("Квартира на Лермонтова 31");
    const sender = vi.spyOn(h.services.sender, "sendMessage").mockRejectedValue(Error("timeout after acceptance"));
    await h.ingest(message("Квартира?"));
    await h.scheduler.runAll();
    await h.ingest(message("Ссылка?"));
    await h.scheduler.runAll();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(1);
  });
});
