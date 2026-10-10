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
      sent_at: "2026-10-09T07:41:35Z", text: "Здравствуйте! Квартира по адресу: Лермонтова 31. " + COOPERATION_QUESTION,
      notes: "cooperation_outreach:v1:102" },
  ]);
  return { h, instanceId, phone, message: (text: string) => h.makeMessage({ instanceId, chatId: phone.slice(1) + "@c.us", text }) };
}
const decision = (intent: string, evidence?: string, language = "ru", extra: Record<string, unknown> = {}) => JSON.stringify({
  intent, language, ...(evidence ? { evidence } : {}), ...extra,
});

describe("LLM cooperation handoff execution", () => {
  it("renders an owner clarification from a semantic classification", async () => {
    const { h, message } = setup();
    const reply = "Пишу по этой квартире: https://example.com/flat/102 (Лермонтова 31)\n\nГотовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?";
    h.llm.responder = () => decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    await h.ingest(message("Какая именно квартира?"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "processed", reply });
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it.each([
    ["identity", "Are you ai?", "handoff_identity"],
    ["terms", "Да, но без комиссии", "handoff_terms"],
  ])("silences %s handoff and future messages without changing CRM status", async (reason, text, intent) => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    h.llm.responder = () => decision(intent, undefined, reason === "identity" ? "en" : "ru");
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
      expect(messages.at(-1)?.content).toBe("Кто мне пишет?");
      return decision("identify", undefined, "ru");
    };
    await h.ingest(message("Кто мне пишет?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual(["Александр, агентство долгосрочной аренды."]);
  });
  it("recovers a saved handoff without asking the model again after a storage failure", async () => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    h.llm.responder = () => decision("handoff_identity", undefined, "en");
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
    const reply = "Пишу по этой квартире: https://example.com/flat/102 (Лермонтова 31)\n\nГотовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe(mixed
        ? "Здравствуйте\nКакая квартира вас интересует?" : "Какая квартира вас интересует?");
      return decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    };
    if (mixed) await h.ingest(message("Здравствуйте"));
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl });
    await h.scheduler.runAll();
    expect(transcribe).toHaveBeenCalledWith(fileUrl);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
  });
  it("stores separate transcripts for multiple audio messages in one batch", async () => {
    const { h, instanceId, phone, message } = setup();
    vi.spyOn(h.services.transcription, "transcribe")
      .mockResolvedValueOnce("Первая расшифровка")
      .mockResolvedValueOnce("Вторая расшифровка");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("Первая расшифровка\nВторая расшифровка");
      return decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    };
    for (const [id, file] of [["audio-1", "one.ogg"], ["audio-2", "two.ogg"]]) {
      await h.ingest({ ...message(""), idMessage: id, type: "audio", rawType: "audioMessage", text: undefined, fileUrl: `https://greenapi.example/${file}` });
    }
    await h.scheduler.runAll();
    const history = await h.store.getHistory(h.key(instanceId, `${phone.slice(1)}@c.us`), 20);
    expect(history.filter(row => row.messageId?.startsWith("audio-")).map(row => [row.messageId, row.content]))
      .toEqual([["audio-1", "Первая расшифровка"], ["audio-2", "Вторая расшифровка"]]);
  });
  it("applies consent from an audio transcript silently", async () => {
    const { h, phone, message } = setup();
    vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Да, квартира актуальна, согласен сотрудничать");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toContain("согласен сотрудничать");
      return decision("consent", "Да, квартира актуальна, согласен сотрудничать", "ru", { selectedListingId: 102 });
    };
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl: "https://greenapi.example/yes.ogg" });
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "agreed")).toBe(true);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("treats consent with a rental-period fact as consent", async () => {
    const { h, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const answer = "Да, готов сотрудничать, но квартиру сдаю только до мая";
    h.llm.responder = () => decision("consent", answer, "ru", { selectedListingId: 102 });
    await h.ingest(message(answer));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "agreed", { suppressTelegram: true, cooperationOnly: true });
    expect(await h.store.getManualHandoff(h.key(h.config.instances[0].id, "995555700090@c.us"))).toBeNull();
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("does not report consent when CRM did not apply the status", async () => {
    const { h, phone, instanceId, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus").mockResolvedValue({ applied: false, status: "new" } as never);
    const answer = "Да, готов сотрудничать";
    h.llm.responder = () => decision("consent", answer, "ru", { selectedListingId: 102 });
    await h.ingest(message(answer));

    const result = (await h.scheduler.runAll())[0];
    const key = h.key(instanceId, `${phone.slice(1)}@c.us`);
    expect(result).toMatchObject({ status: "skipped" });
    expect(setStatus).toHaveBeenCalledWith(102, "agreed", { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === "new")).toBe(true);
    expect(await h.store.getActiveBatch(key)).toBeNull();
    expect(await h.store.pendingCount(key)).toBe(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.llm.calls).toHaveLength(1);
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

    h.llm.responder = messages => {
      const lastUser = messages.filter(row => row.role === "user").at(-1)?.content;
      if (lastUser === clarification) {
        expect(lastUser).not.toContain(COOPERATION_QUESTION);
        return decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
      }
      expect(lastUser).toBe(answer);
      expect(messages.some(row => row.content.includes("original-cooperation-question"))).toBe(false);
      expect(messages.some(row => row.content.includes(COOPERATION_QUESTION))).toBe(true);
      return decision(status === "agreed" ? "consent" : "refusal", answer, "ru", { selectedListingId: 102 });
    };
    await h.ingest(quoted!);
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([
      "Пишу по этой квартире: https://example.com/flat/102 (Лермонтова 31)\n\nГотовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?",
    ]);

    await h.ingest(message(answer));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === status)).toBe(true);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(102, status, { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toHaveLength(1);

    await h.ingest(message("Продолжим разговор?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toHaveLength(1);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
  it("sends the model's apartment answer for the actual transliterated message without a dictionary", async () => {
    const { h, message } = setup();
    const reply = "Pishu po etoy kvartire: https://example.com/flat/102 (Лермонтова 31)\n\nGotovy sotrudnichat s nashim agentstvom po sdache etoy kvartiry v dolgosrochnuyu arendu?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("Kakaia kvartira vas interesuit");
      expect(messages[0].content).toContain("Лермонтова 31");
      return decision("clarify_listing", undefined, "ru_latn", { selectedListingId: 102 });
    };
    await h.ingest(message("Kakaia kvartira vas interesuit"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing[0].message).toBe(reply);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("uses a multi-listing outreach marker as the authoritative target", async () => {
    const { h, instanceId, message } = setup();
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([{
      id: 7, direction: "outgoing", sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:41:35Z", text: "Исходное обращение", notes: "cooperation_outreach:v1:102",
    }]);
    h.llm.responder = messages => {
      expect(messages[0].content).toContain('"sourceListingId":"102"');
      return decision("clarify_listing", undefined, "ru");
    };
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([
      "Пишу по этой квартире: https://example.com/flat/102 (Лермонтова 31)\n\nГотовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?",
    ]);
  });
  it.each([
    ["agreed", "consent", "Да, готов сотрудничать"],
    ["disagreed", "refusal", "Нет, сотрудничать не готов"],
    ["listing_removed", "unavailable", "Квартира уже сдана"],
  ] as const)("executes %s decision silently and stops future replies", async (status, intent, evidence) => {
    const { h, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = () => decision(intent, evidence, "ru", { selectedListingId: 102 });
    await h.ingest(message(evidence));
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
      expect(messages.at(-1)?.content).toBe("здравствуйте уже сдала");
      return decision("unavailable", "уже сдала", "ru", { selectedListingId: 102 });
    };
    await h.ingest(message("здравствуйте уже сдала"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "listing_removed", { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("persists the model decision once across a lost CRM response", async () => {
    const { h, message } = setup();
    h.llm.responder = () => decision("consent", "Согласие своими словами", "ru", { selectedListingId: 102 });
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
    h.llm.responder = () => decision("handoff_terms", undefined, "ru");
    await h.ingest(message("Да, но без комиссии"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", reply: "", stopConversation: true });
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("answers a plain rental-duration statement with the apartment and cooperation question", async () => {
    const { h, message } = setup();
    const reply = "Пишу по этой квартире: https://example.com/flat/102 (Лермонтова 31)\n\nГотовы сотрудничать с нашим агентством по сдаче этой квартиры в долгосрочную аренду?";
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("Сдаю до октября");
      return decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    };
    await h.ingest(message("Сдаю до октября"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", stopConversation: false });
    expect(await h.store.getManualHandoff(h.key(h.config.instances[0].id, "995555700090@c.us"))).toBeNull();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([reply]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("renders a service explanation in the owner's language", async () => {
    const { h, message } = setup();
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("What are you offering?");
      return decision("explain_service", undefined, "en");
    };
    await h.ingest(message("What are you offering?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([
      "We offer help with renting out your apartment long-term. Are you willing to work with our agency to rent out this apartment long-term?",
    ]);
  });
  it("excludes a model-recognized Georgian realtor across all listings without selecting an apartment", async () => {
    const { h, phone, message } = setup();
    const farewell = "ჩვენ უშუალოდ მესაკუთრეებთან ვთანამშრომლობთ.";
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content).toBe("გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50");
      return decision("realtor", "მეც აგენტი ვარ", "ka");
    };
    await h.ingest(message("გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "realtor", { suppressTelegram: true, cooperationOnly: true });
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
    h.llm.responder = () => decision("realtor", "Я агент", "ru");
    await h.ingest(message("Я агент, давайте 50/50"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each(["qualified", "update_rental_terms", "unknown_listing", "invented_link", "historical_evidence"])("rejects model output %s without any writes or sends", async kind => {
    const { h, message } = setup();
    h.llm.responder = () => kind === "qualified" ? JSON.stringify({ intent: "consent", language: "ru", evidence: "Любой вопрос", selectedListingId: 102, actions: [] })
      : kind === "update_rental_terms" ? JSON.stringify({ intent: "consent", language: "ru", evidence: "Любой вопрос", selectedListingId: 102, actions: [{ type: kind, data: { price: 500 } }] })
      : kind === "unknown_listing" ? decision("consent", "Любой вопрос", "ru", { selectedListingId: 999 })
      : kind === "historical_evidence" ? decision("consent", COOPERATION_QUESTION, "ru", { selectedListingId: 102 })
      : JSON.stringify({ intent: "clarify_listing", language: "ru", selectedListingId: 102, reply: "Ссылка: https://invented.invalid/flat/102" });
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
    h.llm.responder = () => decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    await h.ingest(message("Что за квартира?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("quarantines an uncertain send without running the model or sender again", async () => {
    const { h, message } = setup();
    h.llm.responder = () => decision("clarify_listing", undefined, "ru", { selectedListingId: 102 });
    const sender = vi.spyOn(h.services.sender, "sendMessage").mockRejectedValue(Error("timeout after acceptance"));
    await h.ingest(message("Квартира?"));
    await h.scheduler.runAll();
    await h.ingest(message("Ссылка?"));
    await h.scheduler.runAll();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(1);
  });
});
