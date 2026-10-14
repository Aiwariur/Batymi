import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { COOPERATION_QUESTION } from "../../src/conversation/cooperation-agent";
import { normalizeGreenApiWebhook } from "../../src/webhooks/greenapi.normalizer";
import { GreenApiWebhookPayload } from "../../src/greenapi/greenapi.schemas";

function setup() {
  const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only" });
  const instanceId = h.config.instances[0].id, phone = "+995555700090";
  h.crm.setContactState(phone, { status: "new", listings: [
    { id: 102, address: "Лермонтова 31" },
  ] as never });
  vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([
    { id: 1, direction: "outgoing", sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:41:35Z", text: "Здравствуйте! Квартира по адресу: Лермонтова 31. " + COOPERATION_QUESTION,
      notes: "cooperation_outreach:v1:102" },
  ]);
  return { h, instanceId, phone, message: (text: string) => h.makeMessage({ instanceId, chatId: phone.slice(1) + "@c.us", text }) };
}

// Новый JSON-контракт owner-dialogue: модель одной строкой возвращает решение,
// сервис маппит его в отправку/молчание/handoff/стоп.
type OwnerAction = "reply" | "silence" | "handoff" | "stop";
const decision = (action: OwnerAction, reply: string, opts: {
  language?: "ru" | "en" | "ka";
  crmStatus?: "agreed" | "disagreed" | "listing_removed" | "realtor" | null;
  listingScope?: "source" | "other" | "unknown";
  reason?: string;
} = {}) => JSON.stringify({
  action, reply,
  language: opts.language ?? "ru",
  crm_status: opts.crmStatus ?? null,
  listing_scope: opts.listingScope ?? "source",
  reason: opts.reason ?? "решение по последней реплике собственника",
});
const HANDOFF_PREFIX = "owner_dialogue: ";

// Скриптуемые реплики обязаны проходить гварды ядра: ≤350 символов, не повторять
// уже отправленные тексты (включая COOPERATION_QUESTION и outreach), кириллица
// для ru, латиница для en, без выдуманных клиентов.
const REPLY_APARTMENT = "Добрый день! Пишу о квартире на Лермонтова 31. Подскажите, она ещё сдаётся? Мы помогаем собственникам найти жильцов в долгосрочную аренду.";
const REPLY_INTRO = "Меня зовут Александр, я менеджер агентства Batumi Key. Подскажите, пожалуйста, квартира ещё сдаётся?";
const REPLY_AUDIO = "Здравствуйте! Да, речь о квартире на Лермонтова 31. Она ещё сдаётся? Если да, расскажу подробнее про долгосрочную аренду.";
const REPLY_TWO_AUDIOS = "Спасибо за голосовые! Уточните, пожалуйста: квартира на Лермонтова 31 ещё сдаётся?";
const REPLY_TRANSLIT = "Речь о квартире на Лермонтова 31. Она ещё сдаётся? Если удобно, продолжим на русском.";
const REPLY_MARKER = "Пишу насчёт квартиры на Лермонтова 31 — она ещё актуальна для сдачи?";
const REPLY_QUOTED = "Речь о квартире на Лермонтова 31. Актуальна ли ещё сдача? Мы ищем собственников для долгосрочного сотрудничества.";
const REPLY_RENTAL_TERM = "Понимаю, квартиру можно снять до октября. Скажите, сотрудничество с агентством при сдаче вам интересно?";
const REPLY_SERVICE_EN = "We help owners rent out apartments long-term. Would you be open to cooperating with our agency on this apartment?";
const REPLY_TAKEOVER_RECHECK = "Речь о квартире на Лермонтова 31, подскажите, она ещё сдаётся?";
const REPLY_UNCERTAIN_SEND = "Уточните, пожалуйста, квартира на Лермонтова 31 ещё сдаётся?";

describe("LLM cooperation owner-dialogue execution", () => {
  it("sends the model reply verbatim and keeps the dialogue open", async () => {
    const { h, phone, message } = setup();
    h.crm.setContactState(phone, { listings: [
      { id: 101, address: "Кобаладзе 12" }, { id: 102, address: "Лермонтова 31" },
    ] as never });
    h.llm.responder = messages => {
      expect(messages).toHaveLength(2);
      expect(messages[0].content).toContain("Лермонтова 31");
      expect(messages[0].content).not.toContain("Кобаладзе 12");
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Какая именно квартира?")).toBe(true);
      return decision("reply", REPLY_APARTMENT, { reason: "уточняет, о какой квартире речь" });
    };
    await h.ingest(message("Какая именно квартира?"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "processed", reply: REPLY_APARTMENT, stopConversation: false });
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_APARTMENT]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("keeps the dialogue open on a silence decision", async () => {
    const { h, message } = setup();
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Спасибо, понятно")).toBe(true);
      return decision("silence", "", { reason: "вежливая благодарность без нового вопроса" });
    };
    await h.ingest(message("Спасибо, понятно"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "processed", reply: "", stopConversation: false });
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each([
    ["identity", "Are you ai?", "спрашивает, человек ли с ним общается", "en"],
    ["terms", "Да, но без комиссии", "хочет обсудить комиссию напрямую", "ru"],
  ] as const)("silences the %s handoff and future messages without changing CRM status", async (kind, text, reason, language) => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    h.llm.responder = () => decision("handoff", "", { language, reason });
    await h.ingest(message(text));
    const first = (await h.scheduler.runAll())[0];
    expect(first).toMatchObject({ status: "processed", reply: "", stopConversation: true });
    expect(await h.store.getManualHandoff(key)).toBe(HANDOFF_PREFIX + reason);
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
  it("passes the receiving line's representative name into the dialogue prompt", async () => {
    const { h, message } = setup();
    h.config.instances[0].name = "Александр";
    h.llm.responder = messages => {
      expect(messages[0].content).toContain("Александр");
      expect(messages[0].content).toContain("Batumi Key");
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Кто мне пишет?")).toBe(true);
      return decision("reply", REPLY_INTRO, { reason: "представляется и уточняет актуальность" });
    };
    await h.ingest(message("Кто мне пишет?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_INTRO]);
  });
  it("recovers a saved handoff without asking the model again after a storage failure", async () => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, phone.slice(1) + "@c.us");
    const reason = "считает собеседника ботом";
    h.llm.responder = () => decision("handoff", "", { language: "ru", reason });
    const handoff = h.store.handoffToManager.bind(h.store);
    const failOnce = vi.spyOn(h.store, "handoffToManager").mockRejectedValueOnce(Error("Redis temporarily unavailable"))
      .mockImplementation(handoff);
    await h.ingest(message("Это бот мне пишет?"));
    await h.scheduler.runAll();
    expect(failOnce).toHaveBeenCalledTimes(2);
    expect(h.llm.calls).toHaveLength(1);
    expect(await h.store.getManualHandoff(key)).toBe(HANDOFF_PREFIX + reason);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each([false, true])("transcribes cooperation audio and preserves accompanying text (mixed=%s)", async mixed => {
    const { h, message } = setup();
    const fileUrl = "https://greenapi.example/owner.ogg";
    const transcribe = vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Какая квартира вас интересует?");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] " + (mixed
        ? "Здравствуйте\nКакая квартира вас интересует?" : "Какая квартира вас интересует?"))).toBe(true);
      return decision("reply", REPLY_AUDIO, { reason: "уточняет актуальность квартиры" });
    };
    if (mixed) await h.ingest(message("Здравствуйте"));
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl });
    await h.scheduler.runAll();
    expect(transcribe).toHaveBeenCalledWith(fileUrl);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_AUDIO]);
  });
  it("stores separate transcripts for multiple audio messages in one batch", async () => {
    const { h, instanceId, phone, message } = setup();
    vi.spyOn(h.services.transcription, "transcribe")
      .mockResolvedValueOnce("Первая расшифровка")
      .mockResolvedValueOnce("Вторая расшифровка");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Первая расшифровка\nВторая расшифровка")).toBe(true);
      return decision("reply", REPLY_TWO_AUDIOS, { reason: "просит подтвердить актуальность" });
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
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, `${phone.slice(1)}@c.us`);
    const reason = "в голосовом явно согласен сотрудничать";
    vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Да, квартира актуальна, согласен сотрудничать");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Да, квартира актуальна, согласен сотрудничать")).toBe(true);
      return decision("handoff", "", { crmStatus: "agreed", reason });
    };
    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl: "https://greenapi.example/yes.ogg" });
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "agreed")).toBe(true);
    expect(await h.store.getManualHandoff(key)).toBe(HANDOFF_PREFIX + reason);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("treats consent with a rental-period fact as consent", async () => {
    const { h, phone, instanceId, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const reason = "готов сотрудничать, срок описывает квартиру";
    h.llm.responder = () => decision("handoff", "", { crmStatus: "agreed", reason });
    await h.ingest(message("Да, готов сотрудничать, но квартиру сдаю только до мая"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "agreed", { suppressTelegram: true, cooperationOnly: true });
    expect(await h.store.getManualHandoff(h.key(instanceId, "995555700090@c.us"))).toBe(HANDOFF_PREFIX + reason);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("does not report consent when CRM did not apply the status", async () => {
    const { h, phone, instanceId, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus").mockResolvedValue({ applied: false, status: "new" } as never);
    h.llm.responder = () => decision("handoff", "", { crmStatus: "agreed", reason: "явно подтвердил сотрудничество" });
    await h.ingest(message("Да, готов сотрудничать"));

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
    ["agreed", "handoff", "Да, готов сотрудничать с вами"],
    ["disagreed", "stop", "Нет, сотрудничать не готов"],
    ["listing_removed", "stop", "Квартира уже сдана"],
  ] as const)("executes %s silently with crm_status and stops future replies", async (status, action, incoming) => {
    const { h, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const reason = status === "agreed" ? "подтвердил сотрудничество по квартире"
      : status === "disagreed" ? "прямо отказался от сотрудничества с агентством"
      : "квартира уже сдана другому жильцу";
    h.llm.responder = () => decision(action, "", { crmStatus: status, reason });
    await h.ingest(message(incoming));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, status, { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === status)).toBe(true);
    await h.ingest(message("Какая квартира?"));
    const followUp = (await h.scheduler.runAll())[0];
    expect(followUp?.status).toBe(action === "handoff" ? "skipped" : "terminal");
    if (action === "handoff") expect(followUp?.stopConversation).toBe(true);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("uses the quoted owner reply text for the follow-up decision and stops after the terminal decision", async () => {
    const { h, instanceId, phone, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const status = "agreed" as const;
    const clarification = "Какой адрес квартиры?";
    const quoted = normalizeGreenApiWebhook(instanceId, {
      typeWebhook: "incomingMessageReceived",
      idMessage: "quoted-agreed",
      senderData: { chatId: phone.slice(1) + "@c.us" },
      messageData: {
        typeMessage: "quotedMessage",
        extendedTextMessageData: { text: clarification },
        quotedMessage: { idMessage: "original-cooperation-question", textMessage: COOPERATION_QUESTION },
      },
    } as GreenApiWebhookPayload);
    expect(quoted).toMatchObject({ type: "text", text: clarification, rawType: "quotedMessage" });
    const answer = "Да, готов сотрудничать";

    h.llm.responder = messages => {
      const lastUser = messages.at(-1)?.content ?? "";
      if (lastUser.endsWith("[Собственник] " + clarification)) {
        expect(lastUser).toContain(COOPERATION_QUESTION);
        return decision("reply", REPLY_QUOTED, { reason: "называет адрес исходной квартиры" });
      }
      expect(lastUser.endsWith("[Собственник] " + answer)).toBe(true);
      expect(lastUser).toContain(REPLY_QUOTED);
      expect(messages.some(row => row.content.includes("original-cooperation-question"))).toBe(false);
      expect(messages.some(row => row.content.includes(COOPERATION_QUESTION))).toBe(true);
      return decision("handoff", "", { crmStatus: status, reason: "подтвердил сотрудничество по квартире" });
    };
    await h.ingest(quoted!);
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_QUOTED]);

    await h.ingest(message(answer));
    await h.scheduler.runAll();
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === status)).toBe(true);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(setStatus).toHaveBeenCalledWith(102, status, { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toHaveLength(1);

    await h.ingest(message("Продолжим разговор?"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "skipped", stopConversation: true });
    expect(h.llm.calls).toHaveLength(2);
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toHaveLength(1);
    expect(setStatus).toHaveBeenCalledTimes(1);
  });
  it("passes a transliterated question through and answers in Russian Cyrillic", async () => {
    const { h, message } = setup();
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Kakaia kvartira vas interesuit")).toBe(true);
      expect(messages[0].content).toContain("Лермонтова 31");
      return decision("reply", REPLY_TRANSLIT, { reason: "перешёл на кириллицу после транслита" });
    };
    await h.ingest(message("Kakaia kvartira vas interesuit"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing[0].message).toBe(REPLY_TRANSLIT);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("builds the dialogue prompt around the apartment from the outreach marker", async () => {
    const { h, instanceId, message } = setup();
    vi.mocked(h.services.crm.getInteractions).mockResolvedValue([{
      id: 7, direction: "outgoing", sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:41:35Z", text: "Исходное обращение", notes: "cooperation_outreach:v1:102",
    }]);
    h.llm.responder = messages => {
      expect(messages[0].content).toContain("Лермонтова 31");
      expect(messages[0].content).not.toContain("Кобаладзе 12");
      return decision("reply", REPLY_MARKER, { reason: "уточняет актуальность исходной квартиры" });
    };
    await h.ingest(message("Какая квартира?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_MARKER]);
  });
  it("closes an already rented apartment as listing_removed, not refusal", async () => {
    const { h, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] здравствуйте уже сдала")).toBe(true);
      return decision("stop", "", { crmStatus: "listing_removed", reason: "квартира уже сдана собственницей" });
    };
    await h.ingest(message("здравствуйте уже сдала"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "listing_removed", { suppressTelegram: true, cooperationOnly: true });
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it.each([
    ["agreed", "handoff", "Да, готов сотрудничать с вами"],
    ["disagreed", "stop", "Нет, сотрудничать не готов"],
    ["listing_removed", "stop", "Квартира уже сдана"],
  ] as const)("routes %s to review when the contact has multiple listings", async (status, action, incoming) => {
    const { h, phone, instanceId, message } = setup();
    h.crm.setContactState(phone, { listings: [{ id: 101 }, { id: 102 }] as never });
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const reportReview = vi.fn(async () => undefined);
    h.services.crm.reportReview = reportReview;
    h.llm.responder = () => decision(action, "", { crmStatus: status, listingScope: "source" });

    await h.ingest(message(incoming));
    const outcome = (await h.scheduler.runAll())[0];
    const key = h.key(instanceId, `${phone.slice(1)}@c.us`);

    expect(outcome).toMatchObject({ status: "processed", stopConversation: true, reply: "" });
    expect(setStatus).not.toHaveBeenCalled();
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === "new")).toBe(true);
    expect(await h.store.getManualHandoff(key)).toContain("listing_scope_review");
    expect(reportReview).toHaveBeenCalledWith(phone.slice(1), expect.objectContaining({
      reason: expect.stringContaining("listing_scope_review"), state: "review_required",
    }));
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("counts an apartment excluded by the manager filter before allowing a contact status", async () => {
    const { h, phone, instanceId, message } = setup();
    h.crm.setContactState(phone, { listings: [{ id: 101 }, { id: 102 }] as never });
    const readListings = h.crm.getListingsByPhone.bind(h.crm);
    vi.spyOn(h.services.crm, "getListingsByPhone").mockImplementation(async number =>
      (await readListings(number)).map(row => row.id === 101
        ? { ...row, assigned_manager_is_ai: false } : row));
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages[0].content).toContain("Всего квартир контакта в CRM: 2");
      return decision("handoff", "", { crmStatus: "agreed", listingScope: "source" });
    };
    await h.ingest(message("Да, сдаётся"));
    await h.scheduler.runAll();
    expect(setStatus).not.toHaveBeenCalled();
    expect((await readListings(phone)).every(row => row.crm_status === "new")).toBe(true);
    expect(await h.store.getManualHandoff(h.key(instanceId, `${phone.slice(1)}@c.us`)))
      .toContain("listing_scope_review");
  });

  it("rechecks multi-listing scope after planning and blocks later audio automation", async () => {
    const { h, phone, instanceId, message } = setup();
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const reportReview = vi.fn(async () => undefined);
    h.services.crm.reportReview = reportReview;
    const sendMessage = vi.spyOn(h.services.sender, "sendMessage");
    const transcribe = vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Да, готов сотрудничать");
    h.llm.responder = () => {
      h.crm.setContactState(phone, { listings: [{ id: 101 }, { id: 102 }] as never });
      return decision("handoff", "", { crmStatus: "agreed", listingScope: "source" });
    };

    await h.ingest(message("Да, готов сотрудничать"));
    await h.scheduler.runAll();
    expect(setStatus).not.toHaveBeenCalled();
    expect(await h.store.getManualHandoff(h.key(instanceId, `${phone.slice(1)}@c.us`))).toContain("listing_scope_review");
    expect(reportReview).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(h.debug.snapshot().outgoing).toHaveLength(0);

    await h.ingest({ ...message(""), type: "audio", rawType: "audioMessage", text: undefined, fileUrl: "https://greenapi.example/later.ogg" });
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "skipped", stopConversation: true });
    expect(setStatus).not.toHaveBeenCalled();
    expect(reportReview).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(1);
    expect(transcribe).not.toHaveBeenCalled();
    expect(sendMessage).not.toHaveBeenCalled();
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("routes a removed other listing to review and preserves every listing status", async () => {
    const { h, phone, instanceId, message } = setup();
    h.crm.setContactState(phone, { listings: [{ id: 101 }, { id: 102 }] as never });
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    const reportReview = vi.fn(async () => undefined);
    h.services.crm.reportReview = reportReview;
    h.llm.responder = () => decision("stop", "", {
      crmStatus: "listing_removed", listingScope: "other", reason: "другая квартира уже сдана",
    });

    await h.ingest(message("Эту уже сдал, есть другая"));
    await h.scheduler.runAll();

    expect(setStatus).not.toHaveBeenCalled();
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === "new")).toBe(true);
    expect(await h.store.getManualHandoff(h.key(instanceId, `${phone.slice(1)}@c.us`))).toContain("listing_scope_review");
    expect(reportReview).toHaveBeenCalledWith(phone.slice(1), expect.objectContaining({ state: "review_required" }));
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("persists the model decision once across a lost CRM response", async () => {
    const { h, message } = setup();
    h.llm.responder = () => decision("handoff", "", { crmStatus: "agreed", reason: "согласие подтверждено своими словами" });
    const original = h.crm.setStatus.bind(h.crm);
    let attempts = 0;
    vi.spyOn(h.services.crm, "setStatus").mockImplementation(async (...args) => {
      await original(...args);
      if (++attempts === 1) throw Error("response lost after commit");
    });
    await h.ingest(message("Согласна, давайте сотрудничать"));
    await h.scheduler.runAll();
    expect(attempts).toBe(2);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("hands explicit commission conditions to a manager without forcing a CRM status", async () => {
    const { h, instanceId, phone, message } = setup();
    const key = h.key(instanceId, `${phone.slice(1)}@c.us`);
    const reason = "обсуждает комиссию, требует сотрудника";
    h.llm.responder = () => decision("handoff", "", { reason });
    await h.ingest(message("Да, но без комиссии"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", reply: "", stopConversation: true });
    expect(await h.store.getManualHandoff(key)).toBe(HANDOFF_PREFIX + reason);
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === "new")).toBe(true);
  });
  it("answers a plain rental-duration statement and keeps the dialogue open", async () => {
    const { h, instanceId, message } = setup();
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] Сдаю до октября")).toBe(true);
      return decision("reply", REPLY_RENTAL_TERM, { reason: "отвечает по существу и спрашивает далее" });
    };
    await h.ingest(message("Сдаю до октября"));
    const result = (await h.scheduler.runAll())[0];
    expect(result).toMatchObject({ status: "processed", stopConversation: false });
    expect(await h.store.getManualHandoff(h.key(instanceId, "995555700090@c.us"))).toBeNull();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_RENTAL_TERM]);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("replies in English to an English question", async () => {
    const { h, message } = setup();
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] What are you offering?")).toBe(true);
      return decision("reply", REPLY_SERVICE_EN, { language: "en", reason: "объясняет предложение агентства" });
    };
    await h.ingest(message("What are you offering?"));
    await h.scheduler.runAll();
    expect(h.debug.snapshot().outgoing.map(row => row.message)).toEqual([REPLY_SERVICE_EN]);
  });
  it("stops silently on a Georgian realtor across all listings", async () => {
    const { h, phone, message } = setup();
    h.crm.setContactState(phone, { listings: [{ id: 101 }, { id: 102 }] as never });
    const setStatus = vi.spyOn(h.services.crm, "setStatus");
    h.llm.responder = messages => {
      expect(messages.at(-1)?.content?.endsWith("[Собственник] გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50")).toBe(true);
      return decision("stop", "", { language: "ka", crmStatus: "realtor", reason: "собеседник риелтор, предлагает раздел комиссии" });
    };
    await h.ingest(message("გამარჯობა მეც აგენტი ვარ ვითანამშრომლოთ 50/50"));
    await h.scheduler.runAll();
    expect(setStatus).toHaveBeenCalledWith(102, "realtor", { suppressTelegram: true, cooperationOnly: true });
    expect((await h.crm.getListingsByPhone(phone)).every(l => l.crm_status === "realtor")).toBe(true);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    await h.ingest(message("Продолжим сотрудничество?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(h.llm.calls).toHaveLength(1);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("does not exclude a Telegram partner", async () => {
    const { h, phone, message } = setup();
    h.crm.setContactState(phone, { contactType: "partner", listings: [{ id: 101 }, { id: 102 }] as never });
    h.llm.responder = () => decision("stop", "", { crmStatus: "realtor", reason: "называет себя агентом по недвижимости" });
    await h.ingest(message("Я агент, давайте 50/50"));
    await h.scheduler.runAll();
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it.each([
    ["a legacy intent payload", JSON.stringify({ intent: "consent", language: "ru", evidence: "Готов сотрудничать с агентством", selectedListingId: 102, actions: [] })],
    ["an unknown crm_status", JSON.stringify({ action: "stop", reply: "", language: "ru", crm_status: "qualified", reason: "квалифицированный передаётся менеджеру" })],
  ])("rejects %s after three repair rounds without writes or sends", async (_kind, raw) => {
    const { h, message } = setup();
    h.llm.responder = () => raw;
    await h.ingest(message("Любой вопрос"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("quarantined");
    expect(h.llm.calls).toHaveLength(3);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
  });
  it("rechecks manager takeover after the model returns", async () => {
    const { h, instanceId, message } = setup();
    const rows = await h.services.crm.getInteractions("", instanceId);
    vi.mocked(h.services.crm.getInteractions).mockResolvedValueOnce(rows).mockResolvedValue([...rows,
      { id: 2, direction: "outgoing", sender: "manager", instance_id: instanceId, text: "Отвечу вручную", sent_at: "2026-10-09T07:43:00Z" }]);
    h.llm.responder = () => decision("reply", REPLY_TAKEOVER_RECHECK, { reason: "уточняет актуальность квартиры" });
    await h.ingest(message("Что за квартира?"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("persists a manual phone takeover across later batches without CRM history or automation", async () => {
    const { h, instanceId, phone, message } = setup();
    const interactions = vi.mocked(h.services.crm.getInteractions);
    const initialOutreach = {
      id: 1, direction: "outgoing" as const, sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:41:35Z", text: "Initial outreach", notes: "cooperation_outreach:v1:102",
    };
    interactions.mockResolvedValueOnce([initialOutreach, {
      id: 2, direction: "outgoing", sender: "phone", instance_id: instanceId,
      sent_at: "2026-10-09T07:43:00Z", text: "Дальше отвечаю лично",
    }]).mockResolvedValue([initialOutreach]);
    const key = h.key(instanceId, `${phone.slice(1)}@c.us`);

    await h.ingest(message("Первая реплика после вмешательства"));
    expect((await h.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(await h.store.getManualHandoff(key)).toBe("manager_takeover");
    expect(await h.store.getActiveBatch(key)).toBeNull();
    expect(await h.store.pendingCount(key)).toBe(0);

    await h.ingest(message("Следующий вопрос после очистки CRM-истории"));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "skipped", stopConversation: true });
    expect(await h.store.getManualHandoff(key)).toBe("manager_takeover");
    expect(await h.store.getActiveBatch(key)).toBeNull();
    expect(await h.store.pendingCount(key)).toBe(0);
    expect(interactions).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(0);
    expect((await h.crm.getListingsByPhone(phone)).every(row => row.crm_status === "new")).toBe(true);
    expect(h.debug.snapshot().crmActions).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
  it("quarantines an uncertain send without running the model or sender again", async () => {
    const { h, message } = setup();
    h.llm.responder = () => decision("reply", REPLY_UNCERTAIN_SEND, { reason: "уточняет статус квартиры" });
    const sender = vi.spyOn(h.services.sender, "sendMessage").mockRejectedValue(Error("timeout after acceptance"));
    await h.ingest(message("Квартира?"));
    await h.scheduler.runAll();
    await h.ingest(message("Ссылка?"));
    await h.scheduler.runAll();
    expect(sender).toHaveBeenCalledTimes(1);
    expect(h.llm.calls).toHaveLength(1);
  });
});
