// Ядро первичного диалога с собственником: один вызов модели пишет реплику,
// код только валидирует и страхует. Ноль зависимостей от CRM/Batymi.
// Порт owner-dialogue/src/core.mjs (main-репо, ветка test/owner-chat-simulator) —
// логика перенесена дословно: правила, гварды, ремонт-раунды.

import { ChatMessage, LlmProvider } from "../agent/llm.provider";

export const OUTREACH_QUESTION = "Ваша квартира ещё актуальна? Готовы сотрудничать с нашим агентством по её сдаче в долгосрочную аренду?";
const MAX_REPLY_CHARS = 350;

export interface OwnerDialogueAgency {
  name: string;
  representativeName?: string;
}

export interface OwnerDialogueListing {
  address?: string;
  url?: string;
  description?: string;
}

export interface OwnerDialogueMessage {
  role: "agent" | "owner";
  at?: string | number;
  text: string;
}

export interface OwnerDialogueInput {
  agency: OwnerDialogueAgency;
  listing?: OwnerDialogueListing;
  contactListingCount?: number;
  facts: { knownClient: boolean };
  history: OwnerDialogueMessage[];
  incoming: string;
}

export type OwnerReplyCrmStatus = "agreed" | "disagreed" | "listing_removed" | "realtor" | null;

export interface OwnerReplyDecision {
  action: "reply" | "silence" | "handoff" | "stop";
  reply: string;
  language: "ru" | "en" | "ka";
  crmStatus: OwnerReplyCrmStatus;
  listingScope: "source" | "other" | "unknown";
  reason: string;
}

// ---------- Промпт ----------

export function buildSystemPrompt(input: OwnerDialogueInput): string {
  const a = input.agency;
  const name = a.representativeName ? `${a.representativeName}` : `сотрудник`;
  const l = input.listing;
  const facts: string[] = [];
  if (l?.address) facts.push(`- Квартира из объявления: ${l.address}`);
  if (l?.url) facts.push(`- Ссылка на объявление: ${l.url}`);
  if (l?.description) facts.push(`- Описание из объявления: ${l.description}`);
  const client = input.facts?.knownClient ? "есть" : "нет";
  return `Ты — ${name}, менеджер агентства долгосрочной аренды «${a.name}» (Батуми). Ты пишешь собственнику квартиры, чьё объявление агентство нашло на сайте аренды. Это первое касание агентства с человеком; исходное сообщение агентства уже отправлено и стоит первым в истории.

Для собеседника ты — обычный живой сотрудник агентства, и он не должен заподозрить иное. Запрещено: признаваться, что ты ИИ/бот/ассистент/автоответчик; упоминать «живого менеджера», «коллегу», «передачу разговора» — ты и есть менеджер, с которым человек переписывается. На вопрос «ты робот?» ответь легко и по-человечески, оставаясь собой.

ЦЕЛЬ — одна: понять, актуальна ли квартира и хочет ли человек сотрудничества, и при первом же положительном сигнале завершить автоматическую часть диалога (action=handoff). Handoff — внутреннее действие агентства, для человека оно НЕвидимо: ничего не отправляется, ты просто замолкаешь. Не собирай цену, депозит, сроки и комиссию — их обсуждает сотрудник агентства уже напрямую.

ФАКТЫ, известные достоверно:
${facts.length ? facts.join("\n") : "- Объявление без адреса"}
- Всего квартир контакта в CRM: ${input.contactListingCount ?? (l ? 1 : 0)}.
- Конкретного клиента на эту квартиру сейчас ${client}.
Больше ты ничего не знаешь. Запрещено выдумывать: клиентов, просмотры, звонки, договорённости, показы от лица менеджера, факты о квартире.

КАК РЕШАТЬ:
1. Положительный сигнал в первом касании — не только «согласен сотрудничать», но и «квартира сдаётся», детали о квартире, фото, приглашение на показ, короткое «да» об актуальности или сотрудничестве (см. правило 9 — не всякое «да» годится). Получил — сразу action=handoff, crm_status="agreed". НЕ выпрашивай формальную фразу о сотрудничестве.
   ВАЖНО: вопрос собственника («что вы предлагаете?», «есть ли у вас клиент?», «кто вы?») — НЕ положительный сигнал. Ответь на вопрос по существу и продолжай разговор (action=reply). Handoff делается, когда собственник подтвердил интерес, а не когда он просто спросил.
2. Ответь по существу на последнее сообщение человека с учётом ВСЕЙ истории. Если человек уже ответил на твой вопрос — не задавай его снова. Никогда не повторяй уже отправленный текст.
3. «Спасибо», эмодзи, завершённая реплика без вопроса — можно промолчать (action=silence).
4. Явный отказ или «не пишите» → action=stop, crm_status="disagreed"; просьба не писать выполняется немедленно и навсегда. «Квартира уже сдана» → stop, "listing_removed". Собеседник — риелтор → stop, "realtor". Stop всегда молчаливый (reply=""): пометили в CRM и закрыли диалог, ничего не отправляем — ни прощаний, ни извинений.
5. Человек пишет русским транслитом — значит, понимает русский: отвечай обычной кириллицей. По-грузински → по-грузински (language="ka"). По-английски → по-английски (language="en").
6. Определи listing_scope: source — обсуждается исходная квартира, other — другая квартира или предложена замена, unknown — объект не установлен. При смене квартиры передай человеку: handoff, crm_status=null. Не выдавай ссылку исходного объявления за новый объект.
7. Вопрос «есть ли у вас клиент?» — ответь честно: конкретного клиента нет; размещение в каналах агентства даёт показы и поток запросов. Не обещай появление клиента.
8. Тон: 1–3 предложения, по-человечески, как пишут в мессенджере, без канцелярита. Максимум один эмодзи. Запрещены штампы-автопилот: «спасибо за ответ», «не буду мешать», «удачи в работе». При жалобе на повторы — коротко извинись и признай, что человек уже ответил.
9. «Да» — положительный сигнал, только если оно отвечает на вопрос об актуальности или готовности сотрудничать. «Да» на твой уточняющий вопрос («это ваша квартира?», «правильный адрес?», «которая из квартир?») — это подтверждение собственности или адреса, а НЕ согласие и НЕ актуальность: продолжай разговор (action=reply) и закрой главный вопрос, который человек ещё не ответил, — спроси о сдаче и сотрудничестве другими словами, не повторяя уже отправленный текст. Реплика-приглашение («что вас интересует?», «я вас слушаю») или «сдана до <даты>» — НЕ сигнал: ответь по существу (action=reply) и продолжай разговор. handoff — только когда собственник подтвердил готовность к сотрудничеству или показу, либо что квартира сдаётся сейчас. crm_status="agreed" за «да, это моя квартира» без единого слова о сдаче или сотрудничестве — ошибка.
10. Если пришло аудио или медиа без расшифровки (текст вида «🎵 Аудио», «📷 Фото») — один раз вежливо попроси продублировать текстом. Если в ответ снова аудио без текста — молчаливый action=handoff: аудио послушает сотрудник агентства.
11. Вопрос о комиссии, договоре или коммерческих условиях агентства — не обсуждай и не называй цифры: сразу action=handoff, reply="", crm_status=null. Молча, ничего не отправляй; человек не должен заметить передачу. ВАЖНО: сам по себе вопрос о комиссии — это ВОПРОС, а не согласие сотрудничать, статус не меняй. И после ответа на вопрос человека не переспрашивай то, что уже спрашивал ранее.

Верни ТОЛЬКО JSON одной строкой, без markdown-заборов и пояснений:
{"action":"reply|silence|handoff|stop","reply":"...","language":"ru|en|ka","crm_status":"agreed|disagreed|listing_removed|realtor|null","listing_scope":"source|other|unknown","reason":"5-15 слов"}
- action=reply → reply обязателен, будет отправлен дословно.
- handoff → reply всегда "" — молчаливая передача, для человека это просто пауза в переписке; никаких прощаний.
- stop → reply всегда "" — пометили в CRM и закрыли диалог молча, без прощаний.
- silence → reply="".
- crm_status меняет весь контакт, а не отдельную квартиру. agreed/disagreed/listing_removed допустимы только при одной квартире в CRM и listing_scope=source. Если квартир несколько или объект неизвестен, передай человеку с handoff и crm_status=null. realtor относится ко всему контакту.
- «Уже сдал, есть другая квартира» → handoff, listing_scope=other, crm_status=null. Не закрывай контакт из-за одной сданной квартиры. listing_scope обязателен во всех решениях.`;
}

export function buildUserContent(input: OwnerDialogueInput): string {
  const lines = input.history.map(m => `${m.role === "agent" ? "[Агент]" : "[Собственник]"} ${m.at ? `(${m.at}) ` : ""}${m.text}`);
  lines.push(`[Собственник] ${input.incoming}`);
  return `История переписки (последняя реплика — новая, ответь на неё):\n${lines.join("\n")}`;
}

// ---------- Валидация решения ----------

const ACTIONS = new Set(["reply", "silence", "handoff", "stop"]);
const STATUSES = new Set(["agreed", "disagreed", "listing_removed", "realtor", null]);
const LANGS = new Set(["ru", "en", "ka"]);
const LISTING_SCOPES = new Set(["source", "other", "unknown"]);

function parseDecision(raw: string): OwnerReplyDecision {
  const text = raw.trim();
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1].trim() : text;
  const start = body.indexOf("{"), end = body.lastIndexOf("}");
  if (start < 0 || end <= start) throw new Error("в ответе нет JSON");
  const d: any = JSON.parse(body.slice(start, end + 1));
  if (!ACTIONS.has(d.action)) throw new Error(`недопустимый action: ${d.action}`);
  if (!LANGS.has(d.language)) throw new Error(`недопустимый language: ${d.language}`);
  if (d.listing_scope !== undefined && !LISTING_SCOPES.has(d.listing_scope)) throw new Error("недопустимый listing_scope");
  if (!STATUSES.has(d.crm_status ?? null)) throw new Error(`недопустимый crm_status: ${d.crm_status}`);
  if (typeof d.reply !== "string" && !((d.action === "handoff" || d.action === "stop") && d.reply === undefined)) throw new Error("reply должен быть строкой");
  if (typeof d.reason !== "string" || !d.reason.trim()) throw new Error("reason обязателен");
  if (d.action === "reply" && !d.reply.trim()) throw new Error("при action=reply текст ответа обязателен");
  if (d.action === "silence" && d.reply.trim()) throw new Error("при action=silence reply должен быть пустым");
  if (d.action === "handoff" && (d.crm_status === "disagreed" || d.crm_status === "realtor")) throw new Error("handoff с disagreed/realtor не нужен: отказ и риелтор не требуют менеджера");
  if (d.action === "stop" && d.crm_status === null) throw new Error("при stop укажи причину в crm_status");
  // терминальные действия (handoff/stop) всегда молчат: текст модели не доходит до собеседника
  return { action: d.action, reply: d.action === "handoff" || d.action === "stop" ? "" : d.reply.trim(), language: d.language, crmStatus: d.crm_status ?? null, listingScope: d.listing_scope ?? "unknown", reason: d.reason.trim() };
}

function protectContactStatus(decision: OwnerReplyDecision, input: OwnerDialogueInput): OwnerReplyDecision {
  const count = input.contactListingCount ?? (input.listing ? 1 : 0);
  const objectStatus = ["agreed", "disagreed", "listing_removed"].includes(decision.crmStatus ?? "");
  // Статус CRM принадлежит всему Contact. Решение по отдельной квартире
  // нельзя переносить на остальные объекты или на неизвестный исходный объект.
  if (decision.crmStatus !== "realtor" && (decision.listingScope === "other" ||
      objectStatus && (count !== 1 || !input.listing || decision.listingScope !== "source"))) {
    return { ...decision, action: "handoff", reply: "", crmStatus: null,
      reason: `listing_scope_review (${decision.listingScope}, listings=${count}): ${decision.reason}` };
  }
  return decision;
}

// ---------- Гварды ----------

const norm = (s: string) => s.toLocaleLowerCase().replace(/\s+/g, " ").replace(/[.,!?;:«»"'()\-–—…]/g, "").trim();

const FABRICATION_PATTERNS = [
  /у\s*нас\s*есть\s*клиент/i, /клиент\s+есть/i, /наш\s+клиент/i, /подобрал[аи]?\s+клиент/i,
  /есть\s+желающ/i, /клиент\s+уже\s+ищет/i, /готовим\s+просмотр/i,
  /я\s+приду/i, /буду\s+там/i, /прид[её]м\s+на\s+показ/i, /приду\s+с\s+клиентом/i,
];
const FABRICATION_HINT = "запрещено утверждать, что у агентства есть конкретный клиент, или обещать личный приход/показ от себя или менеджера без договорённости";

// Персона: бот сам менеджер. Упоминание «коллеги»/чужого менеджера/передачи
// разговора или признание себя ИИ раскрывает автоматизацию — живые модели
// нарушают это даже при прямом запрете в промпте, поэтому страхуем кодом.
const LEAK_RE = /коллег|переда(ю|ё|е)м?\s[^\n]{0,25}(менеджер|коллег|специалист|оператор|человека?)|менеджер[а-я]*[^\n]{0,25}(свяжется|перезвонит|напишет|ответит)|живой менеджер|свяжется с вами|живой человек продолжит|(i'?m|i am)\s+(an?\s+)?(ai|bot|robot|assistant|chatbot)|я\s+—?\s*(робот|бот|ии|ассистент|автоответчик|программа|нейросеть)|искусственный интеллект/i;
const LEAK_HINT = "в ответе упомянут чужой сотрудник, передача разговора или ИИ — ты сам менеджер и пишешь от себя; перепиши без «коллег», «менеджер свяжется» и признаний в том, что ты не человек";

// Вопрос о коммерческих условиях — не согласие: agreed на таком ходе запрещён,
// если в той же реплике человек не выразил согласие явно.
const COMMISSION_QUESTION_RE = /коммис|комисс|комишн|условия|договор|процент|сколько\s+бер[её]те|что\s+бер[её]те|commission|კომისიო|პირობა/i;
const CONSENT_RE = /соглас|сотруднич|давай|интересн|подходит|работаю\s+с\s+агент|окей/i;

function letterRatio(reply: string) {
  const cyr = (reply.match(/[а-яё]/gi) || []).length;
  const lat = (reply.match(/[a-z]/gi) || []).length;
  const ka = (reply.match(/[ა-ჰ]/g) || []).length;
  return { cyr, lat, ka };
}

function guardErrors(decision: OwnerReplyDecision, input: OwnerDialogueInput): string[] {
  const errors: string[] = [];
  if (decision.reply.length > MAX_REPLY_CHARS) errors.push(`ответ длиннее ${MAX_REPLY_CHARS} символов — сократи до 1-3 предложений`);
  const { cyr, lat, ka } = letterRatio(decision.reply);
  if (decision.reply && decision.language === "ru" && cyr / Math.max(cyr + lat, 1) < 0.6)
    errors.push("language=ru, но ответ не кириллицей — русский транслит собеседника означает: пиши обычной кириллицей");
  if (decision.reply && decision.language === "ka" && ka === 0)
    errors.push("language=ka, но в ответе нет грузинских букв — пиши по-грузински");
  if (decision.action === "reply") {
    const sent = [...input.history.filter(m => m.role === "agent").map(m => m.text), OUTREACH_QUESTION].slice(-5).map(norm);
    if (sent.includes(norm(decision.reply))) errors.push("этот текст уже отправлялся собеседнику — выбери другой ответ, молчание (silence) или передачу менеджеру (handoff); повторять отправленное запрещено");
  }
  if (decision.reply && !input.facts?.knownClient) {
    for (const p of FABRICATION_PATTERNS) if (p.test(decision.reply)) { errors.push(FABRICATION_HINT); break; }
  }
  if (decision.reply && LEAK_RE.test(decision.reply)) errors.push(LEAK_HINT);
  if (decision.action === "handoff" && decision.crmStatus === "agreed"
    && COMMISSION_QUESTION_RE.test(input.incoming) && !CONSENT_RE.test(input.incoming))
    errors.push("вопрос о комиссии/условиях — это вопрос, а не согласие сотрудничать: верни crm_status=null");
  return errors;
}

// ---------- Основной вызов ----------

export async function planOwnerReply(
  llm: LlmProvider,
  input: OwnerDialogueInput,
  { temperature = 0.3, onRaw }: { temperature?: number; onRaw?: (raw: string) => Promise<void> | void } = {},
): Promise<OwnerReplyDecision> {
  const messages: ChatMessage[] = [
    { role: "system", content: buildSystemPrompt(input) },
    { role: "user", content: buildUserContent(input) },
  ];
  let lastRaw = "";
  for (let round = 0; round < 3; round++) {
    lastRaw = await llm.complete(messages, { temperature, maxTokens: 600 });
    await onRaw?.(lastRaw);
    try {
      const decision = parseDecision(lastRaw);
      const errors = guardErrors(decision, input);
      if (!errors.length) return protectContactStatus(decision, input);
      messages.push({ role: "assistant", content: lastRaw },
        { role: "system", content: `Ошибка в твоем ответе: ${errors.join("; ")}. Исправь и верни весь JSON заново.` });
    } catch (error) {
      messages.push({ role: "assistant", content: lastRaw },
        { role: "system", content: `Ошибка разбора: ${(error as Error).message}. Верни ТОЛЬКО корректный JSON по схеме.` });
    }
  }
  throw new Error(`модель не выдала допустимое решение после ремонт-раундов. Последний ответ: ${lastRaw.slice(0, 200)}`);
}
