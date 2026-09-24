import { randomUUID } from "crypto";
import { Listing, NormalizedMessage } from "../types";
import { Services } from "../services";
import { buildSystemPrompt, resolvePhase } from "../agent/system-prompt";
import { runAgent } from "../agent/agent";
import { executeActions } from "../agent/actions";
import { applyGates } from "../agent/gates";
import { mergeActionsOntoListing, qualifiedMissingFields } from "../agent/gates";
import { AgentAction, AgentResult } from "../agent/schemas";
import { appendHistory, getHistory } from "./history.service";
import { groundRentalFacts } from "./rental-facts";
import { debounceTtlMs } from "../buffer/keys";
import { ActiveBatch, OutboundIntent } from "../buffer/conversation-store";

const MAX_MANUAL_RETRIES = 2;

export interface ConversationJobInput {
  conversationKey: string;
  token: string;
  retryCount?: number;
}

export interface ConversationJobMeta {
  attemptsMade: number;
  maxAttempts: number;
  jobId?: string;
}

export type RunStatus =
  | "processed"
  | "skipped"
  | "empty"
  | "rescheduled"
  | "terminal"
  | "quarantined"
  | "failed";

export interface RunOutcome {
  status: RunStatus;
  runId: string;
  executedActions?: string[];
  reply?: string;
  stopConversation?: boolean;
}

export function parseConversationKey(conversationKey: string): { instanceId: string; chatId: string } {
  const index = conversationKey.indexOf(":");
  if (index === -1) return { instanceId: conversationKey, chatId: "" };
  return {
    instanceId: conversationKey.slice(0, index),
    chatId: conversationKey.slice(index + 1),
  };
}

function outcome(status: RunStatus, runId: string, extra: Partial<RunOutcome> = {}): RunOutcome {
  return { status, runId, ...extra };
}

export function filterListingsByManager(
  listings: Listing[],
  instanceManagerId: number | undefined,
  allowedManagerIds: number[],
): Listing[] {
  if (instanceManagerId !== undefined) {
    return listings.filter((listing) => Number(listing.assigned_manager_id) === instanceManagerId);
  }
  return listings.filter((listing) => managerAllowedForAgent(listing, allowedManagerIds));
}

/**
 * Диалог нашего агента — тот, где ответственный контакт помечен в CRM как
 * AI-агент (Manager.is_ai → assigned_manager_is_ai). Флаг неизвестен (старая
 * CRM / менеджер не назначен) — легаси-режим по ALLOWED_MANAGER_IDS.
 */
function managerAllowedForAgent(listing: Listing, allowedManagerIds: number[]): boolean {
  if (listing.assigned_manager_is_ai === true) return true;
  if (listing.assigned_manager_is_ai === false) return false;
  if (allowedManagerIds.length > 0) {
    return allowedManagerIds.includes(Number(listing.assigned_manager_id));
  }
  return true;
}

export function isTerminalListing(listing: Listing, terminalStatuses: string[]): boolean {
  const status = (listing.crm_status ?? "").toLowerCase();
  if (terminalStatuses.includes(status)) return true;
  if ((listing.contact_type ?? "").toLowerCase() === "realtor") return true;
  return false;
}

async function resolveBatchText(
  batch: NormalizedMessage[],
  services: Services,
): Promise<string> {
  const parts: string[] = [];
  for (const message of batch) {
    if (message.type === "text" && message.text) {
      parts.push(message.text);
    } else if (message.type === "audio" && message.fileUrl) {
      const transcript = await services.transcription.transcribe(message.fileUrl);
      if (transcript) parts.push(transcript);
    } else if ((message.type === "image" || message.type === "document") && message.text) {
      parts.push(message.text);
    }
  }
  return parts.join("\n").trim();
}

function replyLanguage(text: string): "ru" | "ka" | "en" {
  if (/[\u10a0-\u10ff]/.test(text)) return "ka";
  if (/[А-Яа-яЁё]/.test(text)) return "ru";
  if (/\b(da+|mozhno|mozhna|god|sobstvennik|sotrudnich|vid|more)\b/i.test(text)) return "ru";
  return "en";
}

function wasAsked(history: { role: string; content: string }[], pattern: RegExp): boolean {
  return history.some((entry) => entry.role === "assistant" && pattern.test(entry.content.toLowerCase()));
}

function closingReply(text: string): string {
  const language = replyLanguage(text);
  return language === "ru"
    ? "Спасибо, всё необходимое для подготовки объявления зафиксировал. Менеджер свяжется с вами при необходимости."
    : language === "ka"
      ? "გმადლობთ, განცხადების მოსამზადებლად საჭირო ინფორმაცია ჩავიწერე. საჭიროების შემთხვევაში მენეჯერი დაგიკავშირდებათ."
      : "Thank you, I have all the details needed to prepare the listing. The manager will contact you if needed.";
}

/** Safe question used when a model acknowledges agreement but omits phase 2. */
function agreedPhaseFallback(text: string, listing: Listing, missingFields: string[] = [], history: { role: string; content: string }[] = []): string {
  const language = replyLanguage(text);
  const hasView = Boolean(listing.window_view?.trim()) || wasAsked(history, /вид из окон|view from the windows|ფანჯრებიდან.*ხედი/);
  const hasComplex = Boolean(listing.complex_name?.trim()) || wasAsked(history, /(?:^|[^а-яё])жк(?:$|[^а-яё])|комплекс|residential complex|საცხოვრებელ კომპლექს/);
  const questions: Record<typeof language, string[]> = {
    ru: [
      ...(hasView ? [] : ["Какой вид из окон (море, горы, двор или улица)?"]),
      ...(hasComplex ? [] : ["В каком ЖК находится квартира? Если это отдельный дом, как его назвать?"]),
    ],
    en: [
      ...(hasView ? [] : ["What is the view from the windows (sea, mountains, courtyard, or street)?"]),
      ...(hasComplex ? [] : ["Which residential complex is the apartment in? If it is a standalone building, what is its name?"]),
    ],
    ka: [
      ...(hasView ? [] : ["ფანჯრებიდან რა ხედი იშლება — ზღვა, მთები, ეზო თუ ქუჩა?"]),
      ...(hasComplex ? [] : ["რომელ საცხოვრებელ კომპლექსშია ბინა? თუ ცალკე სახლია, რა ჰქვია მას?"]),
    ],
  };
  const items = questions[language];
  const termQuestions: Record<string, Record<typeof language, string>> = {
    "rental_terms.price": { ru: "Какая цена аренды в месяц?", en: "What is the monthly rent?", ka: "რა არის ქირის თვიური ფასი?" },
    "rental_terms.currency": { ru: "В какой валюте указана цена?", en: "Which currency is the price in?", ka: "რომელ ვალუტაშია მითითებული ფასი?" },
    "rental_terms.availability_status": { ru: "Квартира сейчас доступна для долгосрочной аренды?", en: "Is the apartment currently available for long-term rent?", ka: "ბინა ამჟამად ხელმისაწვდომია გრძელვადიანი ქირისთვის?" },
    "rental_terms.minimum_lease_months": { ru: "Какой минимальный срок аренды?", en: "What is the minimum rental period?", ka: "რა არის ქირავნობის მინიმალური ვადა?" },
    "rental_terms.price_period": { ru: "Правильно понимаю, цена указана за месяц?", en: "Is the quoted rent per month?", ka: "სწორად გავიგე, ფასი თვეზეა მითითებული?" },
    "rental_terms.transaction_type": { ru: "Правильно понимаю, речь о долгосрочной аренде?", en: "Is this for long-term rent?", ka: "სწორად გავიგე, საუბარია გრძელვადიან ქირაზე?" },
  };
  for (const field of missingFields) {
    const question = termQuestions[field]?.[language];
    if (question && !items.includes(question)) items.push(question);
  }
  if (items.length === 0) {
    return language === "ru"
      ? "Всё необходимое зафиксировал. Правильно ли понял, что можно передать данные менеджеру?"
      : language === "ka"
        ? "ყველაფერი საჭირო ჩავიწერე. სწორად გავიგე, რომ მონაცემები მენეჯერს გადავცე?"
        : "I have all the necessary details. Did I understand correctly that I can pass them to the manager?";
  }
  const intro = language === "ru"
    ? "Спасибо! Чтобы подготовить объявление, уточню сразу:"
    : language === "ka"
      ? "გმადლობთ! განცხადების მოსამზადებლად, გთხოვთ, დამიზუსტოთ:"
      : "Thank you! To prepare the listing, could you clarify:";
  return `${intro}\n${items.map((item) => `— ${item}`).join("\n")}`;
}

function phaseTwoWasAsked(history: { role: string; content: string }[]): boolean {
  return history.some((entry) => entry.role === "assistant" &&
    /[?？]/.test(entry.content) &&
    /вид|view|ხედი/.test(entry.content.toLowerCase()) &&
    /жк|комплекс|residential complex|საცხოვრებელ კომპლექს/.test(entry.content.toLowerCase()));
}

export function explicitCooperationConsent(text: string, history: { role: string; content: string }[]): boolean {
  const normalized = text.trim().toLowerCase();
  if (!normalized) return false;
  const refusal = /не\s+(хочу|готов|буду)\s+(работать|сотрудничать)|не\s+интересно|не\s+нужно|не\s+пишите|не\s+беспокойте|don't\s+(want|work)|not\s+interested|no\s+thank|არ\s+მინდა|არ\s+ვთანამშრომლობ/.test(normalized);
  if (refusal) return false;
  const clearConsent = /готов(а|ы)?\s+(работать|сотрудничать)|да(,\s*конечно)?[,! ]+.{0,35}(работать|сотрудничать|агентств)|можно\s+работать|давайте\s+работать|согласен\s+сотрудничать|i('?m| am)\s+(happy|ready)\s+to\s+work|yes[,! ]+.{0,30}(work|agency)|კი[,! ]+.{0,30}(თანამშრომლ|აგენტ)|თანახმა\s+ვარ/.test(normalized);
  if (clearConsent) return true;
  const bareYes = /^(да|да\s*[,!.]*|da+|mozhno|mozhna|можно|можна|конечно|готов|готова|კი|დიახ|yes|sure|okay|ok)[!. ]*$/i.test(normalized);
  const lastAssistant = [...history].reverse().find((entry) => entry.role === "assistant")?.content.toLowerCase() ?? "";
  const lastAssistantAskedConsent = assistantAskedDirectCooperation(lastAssistant);
  const contextualYes = /(^|\s)(da+|mozhno|mozhna|можно|можна|კი|დიახ|yes|sure)(?=$|[\s,.!])/i.test(normalized);
  return (bareYes || contextualYes) && lastAssistantAskedConsent;
}

function assistantAskedCooperation(text: string): boolean {
  return /сотруднич|работать.{0,50}агентств|агентств.{0,50}работать|work with.{0,30}agency|agency.{0,30}work|collaborat|თანამშრომლობ/.test(text.toLowerCase());
}

function assistantAskedDirectCooperation(text: string): boolean {
  const normalized = text.toLowerCase();
  if (!assistantAskedCooperation(normalized)) return false;
  const lastQuestion = normalized.split(/[?？]/).at(-2) ?? normalized;
  // A short yes can only answer a single, explicit cooperation question.
  // Combined owner/cooperation or availability/cooperation questions are ambiguous.
  if (/собственник|владелец|хозяин|owner|მფლობელ|მეპატრონე|доступн|свободн|сда[её]тся|available|vacant|ქირავდება/.test(lastQuestion)) return false;
  return assistantAskedCooperation(lastQuestion);
}

function assistantAskedOwner(text: string): boolean {
  return /[?？]/.test(text) && /собственник|владелец|хозяин|owner|მფლობელ|მეპატრონე/.test(text.toLowerCase());
}

function assistantAskedOwnerOnly(text: string): boolean {
  if (!/[?？]/.test(text)) return false;
  // An introduction before the question is not another question. In particular,
  // "We help find tenants. Are you the owner?" has one unambiguous yes/no target.
  const lastQuestion = (text.toLowerCase().split(/[?？]/).at(-2) ?? "").split(/[.!\n]/).at(-1) ?? "";
  return /собственник|владелец|хозяин|owner|მფლობელ|მეპატრონე/.test(lastQuestion) &&
    !/сотруднич|работать|agency|work with|თანამშრომლ|доступн|свободн|сда[её]тся|available|vacant|актуальн|ქირავდება|цен|аренд|rent|price|депозит|залог|минимальн.*срок/.test(lastQuestion);
}

function explicitOwnerStatement(text: string): boolean {
  const normalized = text.trim().toLowerCase();
  if (explicitRealtorStatement(normalized)) return false;
  return /я\s+(собственник|владелец|хозяин)|^(?:да[,! ]*)?(?:я\s+)?(?:собственник|владелец|хозяин)(?=$|[\s,.!])|моя\s+(квартира|недвижимость)|мой\s+(объект|квартира|дом)|это\s+мой\s+объект|i\s+(am\s+)?the\s+owner|i\s+own\s+(this\s+)?(flat|apartment)|მე\s+(ვარ\s+)?(მეპატრონე|მფლობელი)|ჩემი\s+ბინა|me\s+var\s+mepatrone/i.test(normalized);
}

function explicitRealtorStatement(text: string): boolean {
  const normalized = text.toLowerCase();
  // A mention or a question about our agent is not the speaker's identity.
  return /(?:^|[\s,.!])я\s+(?:риелтор|риэлтор|р[еэ]алтор|агент|брокер)(?=$|[\s,.!])|^(?:да[,! ]*)?(?:риелтор|риэлтор|агент|брокер)[.!\s]*$|(?:^|[\s,.!])(?:я\s+)?не\s+(?:являюсь\s+)?(?:собственник|владелец|хозяин)(?=$|[\s,.!])|\b(?:i am|i'm)\s+(?:not\s+(?:the\s+)?owner|(?:a\s+)?(?:realtor|real estate agent|broker))\b|^not\s+(?:the\s+)?owner[.!\s]*$|მე\s+(?:ვარ\s+)?აგენტი|^აგენტი[.!\s]*$/i.test(normalized);
}

function ownerConfirmedFromHistory(history: { role: string; content: string }[], listing: Listing, currentText: string): boolean {
  if ((listing.contact_type ?? "").toLowerCase() === "owner") return true;
  if ([...history.filter((entry) => entry.role === "user").map((entry) => entry.content), currentText].some(explicitOwnerStatement)) return true;
  return history.some((entry, index) =>
    entry.role === "assistant" && assistantAskedOwnerOnly(entry.content) &&
    history[index + 1]?.role === "user" && /^(да|yes|კი|დიახ|da+)[!. ,]*$/i.test(history[index + 1].content.trim()),
  ) || (assistantAskedOwnerOnly([...history].reverse().find((entry) => entry.role === "assistant")?.content ?? "") &&
    /^(?:(?:да|yes|კი|დიახ|da+)[!. ,]*|(?:да|da+)[, ]+(?:моя|ma[iy]a)(?:\s+квартира)?[!. ,]*)$/i.test(currentText.trim()));
}

function hasPhaseTwoAnswer(text: string): boolean {
  const normalized = text.toLowerCase();
  return /вид|view|хори|ხედი|море|моря|горы|гор|двор|улиц|sea|mountain|courtyard|street|жк|комплекс|residential complex|საცხოვრებელ კომპლექს/.test(normalized);
}

function hasAvailabilityEvidence(ownerText: string, currentOwnerText: string, lastAssistantText: string): boolean {
  const text = ownerText.toLowerCase();
  const negative = /не\s+(сда[её]тся|свободн|доступн)|уже\s+(сдан|занят)|занята|арендована|not\s+available|already\s+rented|არ\s+(ქირავდება|არის\s+თავისუფალი)/;
  const explicitAvailable = /сда[её]тся|свободн|доступна|доступно|актуальн|available|vacant|ქირავდება|თავისუფალია|ხელმისაწვდომია/;
  if (!negative.test(text) && explicitAvailable.test(text)) return true;
  const askedAvailability = /[?？]/.test(lastAssistantText) && /доступн|свободн|сда[её]тся|available|vacant|ხელმისაწვდომ|ქირავდება/.test(lastAssistantText.toLowerCase());
  return askedAvailability && /^(да|yes|კი|დიახ|daa+|da+)[!. ,]*$/i.test(currentOwnerText.trim());
}

function hasExplicitUnavailableEvidence(text: string): boolean {
  return /не\s+(?:сда[её]тся|свободн\w*|доступн\w*)|уже\s+(?:сдал[аи]?|сдан\w*|занят\w*|арендован\w*)|(?:сдал[аи]?|сдан\w*|занят\w*|арендован\w*)\s+(?:квартир\w*|объект\w*)|(?:ara|net)[, ]+uzhe\s+(?:sdali|sdana)|not\s+available|already\s+rented|არ\s+(?:ქირავდება|არის\s+თავისუფალი)/i.test(text);
}

function hasDefinitiveRefusal(text: string): boolean {
  const normalized = text.toLowerCase();
  if (/не\s+(?:уверен|уверена|знаю)|пока\s+не\s+готов\w*|не\s+сейчас|может\s+позже|подумаю|не\s+определил\w*/.test(normalized)) return false;
  return /не\s+(?:хочу|буду)\s+(?:работать|сотрудничать)|не\s+интересно|точно\s+не\s+нужно|не\s+пишите|не\s+беспокойте|передумал\w*|отказываюсь\s+(?:от\s+)?(?:сотрудничества|работы)|don't\s+(?:want|wish)\s+to\s+(?:work|collaborate)|not\s+interested|do\s+not\s+contact|არ\s+მინდა\s+თანამშრომლობა/i.test(normalized);
}

function groundedRentalActions(actions: AgentAction[], ownerText: string, lastAssistantText: string, currentOwnerText: string): AgentAction[] {
  const text = ownerText.toLowerCase();
  const lastAssistant = lastAssistantText.toLowerCase();
  const mentionsCommission = /комисс|commission|საკომისიო/.test(text);
  const numberPresent = (value: unknown, source = text) => {
    const numeric = Number(String(value).replace(/[^\d,.-]/g, "").replace(",", "."));
    return Number.isFinite(numeric) && new RegExp(`(^|[^\\d])${String(numeric).replace(".", "[.,]")}(?!\\d)`).test(source.toLowerCase());
  };
  const amountNear = (value: unknown, keywords: RegExp) => {
    const numeric = Number(String(value).replace(/[^\d,.-]/g, "").replace(",", "."));
    if (!Number.isFinite(numeric)) return false;
    const amount = new RegExp(`(^|[^\\d])${String(numeric).replace(".", "[.,]")}(?!\\d)`, "g");
    for (const source of [text, lastAssistant]) {
      if (source === lastAssistant && !keywords.test(lastAssistant)) continue;
      for (const match of source.matchAll(amount)) {
        const start = Math.max(0, (match.index ?? 0) - 45);
        const end = Math.min(source.length, (match.index ?? 0) + match[0].length + 45);
        if (keywords.test(source.slice(start, end))) return true;
      }
    }
    return false;
  };
  const grounded: AgentAction[] = [];
  for (const action of actions) {
    if (action.type !== "update_rental_terms") {
      grounded.push(action);
      continue;
    }
    const data = { ...action.data } as Record<string, unknown>;
    if (data.availability_status === "available" && !hasAvailabilityEvidence(ownerText, currentOwnerText, lastAssistantText)) {
      delete data.availability_status;
    }
    const priceAsked = /цен[ау]|monthly rent|rent per month|ქირის ფას/.test(lastAssistant);
    const depositAsked = /депозит|залог|deposit/.test(lastAssistant);
    const prepaymentAsked = /предоплат|аванс|заранее|впер[её]д|prepay|advance|upfront/.test(lastAssistant);
    const leaseAsked = /минимальн.*срок|срок аренды|minimum.*rental period|lease term|მინიმალურ.*ვად/.test(lastAssistant);
    if (data.price !== undefined && !amountNear(data.price, /цен[ау]|аренд|rent|price|в месяц|per month|\$|€|₾|лари|доллар/ ) && !(priceAsked && numberPresent(data.price, text))) delete data.price;
    if (data.deposit_amount !== undefined && !amountNear(data.deposit_amount, /депозит|залог|deposit/) && !(depositAsked && numberPresent(data.deposit_amount, text))) delete data.deposit_amount;
    if (data.prepayment_months !== undefined && !amountNear(data.prepayment_months, /предоплат|аванс|заранее|впер[её]д|prepay|advance|upfront/) && !(prepaymentAsked && numberPresent(data.prepayment_months, text))) delete data.prepayment_months;
    if (data.minimum_lease_months !== undefined) {
      const months = Number(data.minimum_lease_months);
      const explicitMonths = amountNear(months, /минимальн.*срок|срок аренды|месяц|month|lease|ვად|თვე/);
      const years = Number.isInteger(months / 12) && new RegExp(`(^|[^\\d])${months / 12}(?!\\d)\\s*(год|года|лет|year|years|god)`).test(text);
      const contextualMonths = leaseAsked && numberPresent(months, text);
      const contextualYears = leaseAsked && Number.isInteger(months / 12) && new RegExp(`(^|[^\\d])${months / 12}(?!\\d)\\s*(год|года|лет|year|years|god)`).test(text);
      if (!explicitMonths && !years && !contextualMonths && !contextualYears) delete data.minimum_lease_months;
    }
    if (data.currency !== undefined) {
      const currencyText = /\b(usd|eur|gel|rub|лари|доллар|евро|рубл)\b|[$€₾₽]/i;
      if (!currencyText.test(text)) delete data.currency;
    }
    if (!mentionsCommission) {
      delete data.commission_type;
      delete data.commission_value;
      delete data.commission_payer;
      delete data.commission_notes;
    } else {
      const typeEvidence: Record<string, RegExp> = {
        fixed: /фиксир.*комисс|фиксированн.*комисс|fixed commission|flat fee/,
        percent_month: /комисс.{0,40}%|%\s*.{0,20}комисс|процент.{0,25}комисс|commission.{0,40}%|commission.{0,30}percent/,
        months: /комисс.{0,30}(месяц|month)|(?:месяц|month).{0,30}комисс|commission.{0,30}months?/,
      };
      if (data.commission_type && !typeEvidence[String(data.commission_type)]?.test(text)) delete data.commission_type;
      if (data.commission_value !== undefined && !numberPresent(data.commission_value)) delete data.commission_value;
      const payerEvidence: Record<string, RegExp> = {
        owner: /комисс.{0,40}(собственник|владелец|owner)|(?:собственник|владелец|owner).{0,40}комисс|საკომისიო.{0,30}მფლობელ/,
        tenant: /комисс.{0,40}(арендатор|клиент|tenant)|(?:арендатор|клиент|tenant).{0,40}комисс|საკომისიო.{0,30}მოიჯარ/,
        split: /комисс.{0,40}(пополам|делим|split)|(?:пополам|делим|split).{0,40}комисс|საკომისიო.{0,30}ნახევარ/,
      };
      if (data.commission_payer && !payerEvidence[String(data.commission_payer)]?.test(text)) delete data.commission_payer;
      if (data.commission_notes && !text.includes(String(data.commission_notes).trim().toLowerCase())) delete data.commission_notes;
    }
    if (Object.keys(data).length) grounded.push({ ...action, data: data as typeof action.data });
  }
  return grounded;
}

function qualificationRecoveryReply(text: string, reason: string): string {
  const language = replyLanguage(text);
  const fields = reason.match(/qualified_incomplete:([^;]+)/)?.[1]?.split(",") ?? [];
  const labels: Record<string, Record<typeof language, string>> = {
    "rental_terms.price": { ru: "цену в месяц", en: "the monthly rent", ka: "თვიური ქირის ფასს" },
    "rental_terms.currency": { ru: "валюту цены", en: "the currency", ka: "ვალუტას" },
    "rental_terms.availability_status": { ru: "сдаётся ли квартира сейчас", en: "whether the apartment is still available", ka: "კვლავ ქირავდება თუ არა ბინა" },
    "rental_terms.minimum_lease_months": { ru: "минимальный срок аренды", en: "the minimum rental period", ka: "ქირავნობის მინიმალურ ვადას" },
    "rental_terms.price_period": { ru: "подтвердите, пожалуйста, цена указана за месяц", en: "please confirm that the rent is per month", ka: "გთხოვთ, დაადასტუროთ, ფასი თვეზეა მითითებული" },
    "rental_terms.transaction_type": { ru: "подтвердите, пожалуйста, речь о долгосрочной аренде", en: "please confirm this is for long-term rent", ka: "გთხოვთ, დაადასტუროთ, საუბარია გრძელვადიან ქირაზე" },
  };
  const askable = fields.map((field) => labels[field]?.[language]).filter((item): item is string => Boolean(item));
  if (askable.length === 0) {
    return language === "ru"
      ? "Спасибо, записал. Менеджер проверит оставшиеся данные перед подготовкой объявления."
      : language === "ka"
        ? "გმადლობთ, ჩავიწერე. განცხადების მომზადებამდე მენეჯერი დარჩენილ მონაცემებს გადაამოწმებს."
        : "Thank you, I have noted that. The manager will check the remaining details before preparing the listing.";
  }
  const lead = language === "ru" ? "Чтобы завершить карточку, уточните, пожалуйста:" : language === "ka" ? "ბარათის შესავსებად, გთხოვთ, დამიზუსტოთ:" : "To complete the listing details, could you clarify:";
  return `${lead}\n${askable.map((item) => `— ${item}`).join("\n")}?`;
}

function primaryPhaseFallback(text: string, listing: Listing, history: { role: string; content: string }[] = [], languageText = text): string {
  const language = replyLanguage(languageText);
  const ownerConfirmed = ownerConfirmedFromHistory(history, listing, text);
  // Keep owner identity and agency consent on separate turns, so a short yes
  // cannot be interpreted as agreeing to both at once.
  if (!ownerConfirmed) {
    const introduced = wasAsked(history, /batumi\.key/);
    return language === "ru" ? `${introduced ? "" : "Я Андрей из Batumi.key, подбираем арендаторов в Батуми. "}Вы собственник этой квартиры?`
      : language === "ka" ? `${introduced ? "" : "მე ანდრეი ვარ Batumi.key-დან, ბათუმში მოიჯარეებს ვეძებთ. "}თქვენ ხართ ამ ბინის მფლობელი?`
        : `${introduced ? "" : "I'm Andrey from Batumi.key. We help find tenants in Batumi. "}Are you the owner of this apartment?`;
  }
  if (!explicitCooperationConsent(text, history)) {
    return language === "ru" ? "Готовы сотрудничать с агентством?"
      : language === "ka" ? "თანახმა ხართ სააგენტოსთან თანამშრომლობაზე?"
        : "Would you be willing to work with our agency?";
  }
  const terms = listing.rental_terms ?? {};
  const priceAsked = wasAsked(history, /цен[ау]|monthly rent|ქირის ფას/);
  const depositAsked = wasAsked(history, /депозит|залог|deposit/);
  const minimumAsked = wasAsked(history, /минимальн.*срок|minimum.*rental period|მინიმალურ.*ვად/);
  const questions: Record<typeof language, string[]> = {
    ru: [
      ...(terms.price || priceAsked ? [] : ["Какая цена аренды в месяц?"]),
      ...(terms.deposit_amount !== undefined && terms.deposit_amount !== null || depositAsked ? [] : ["Какой депозит? Если его нет, так и скажите."]),
      ...(terms.minimum_lease_months || minimumAsked ? [] : ["Какой минимальный срок аренды?"]),
    ],
    en: [
      ...(terms.price || priceAsked ? [] : ["What is the monthly rent?"]),
      ...(terms.deposit_amount !== undefined && terms.deposit_amount !== null || depositAsked ? [] : ["Is there a deposit? If not, please say so."]),
      ...(terms.minimum_lease_months || minimumAsked ? [] : ["What is the minimum rental period?"]),
    ],
    ka: [
      ...(terms.price || priceAsked ? [] : ["რა არის ქირის თვიური ფასი?"]),
      ...(terms.deposit_amount !== undefined && terms.deposit_amount !== null || depositAsked ? [] : ["არის დეპოზიტი? თუ არა, გთხოვთ, ასე მიუთითოთ."]),
      ...(terms.minimum_lease_months || minimumAsked ? [] : ["რა არის ქირავნობის მინიმალური ვადა?"]),
    ],
  };
  const lead = language === "ru" ? "Подскажите, пожалуйста:" : language === "ka" ? "გთხოვთ, დამიზუსტოთ:" : "Could you please clarify:";
  const items = questions[language];
  if (items.length === 0) {
    return language === "ru"
      ? "Есть ли ещё что-то важное, что нужно учесть по квартире?"
      : language === "ka"
        ? "არის კიდევ რაიმე მნიშვნელოვანი, რაც ბინის შესახებ უნდა გავითვალისწინო?"
        : "Is there anything else important I should know about the apartment?";
  }
  return `${lead}\n${items.map((item) => `— ${item}`).join("\n")}`;
}

/** Repair only obviously broken messages, not every answer that lacks a checklist. */
function unusableConversationalReply(reply: string): boolean {
  return !reply || /[:：]$/.test(reply) ||
    /как (?:я )?могу (?:вам )?помочь|чем (?:я )?могу (?:вам )?помочь|how (?:can|may) i help/i.test(reply) ||
    /автоматическ\S* (?:предложен|действ|обработ)|по этому контакту|stopConversation|set_crm_status/i.test(reply) ||
    /^(?:(?:здравствуйте|добрый день|привет|отлично|записал|принял|понял|спасибо|хорошо|ладно|да|yes|da+|კი|დიახ|sure|ok|okay|understood|thanks|thank you|noted)[!.,\s]*)+$/i.test(reply) ||
    /не уверен, что правильно понял|not sure i understood|დარწმუნებული არ ვარ, სწორად გავიგე/i.test(reply);
}

function isConversationalQuestion(text: string): boolean {
  return /[?？]|(?:^|\s)(?:какая|какую|какой|какие|кто|зачем|почему|сколько|где|what|which|who|why|how)(?:\s|$)/i.test(text);
}

function acknowledgementWithoutNextStep(reply: string): boolean {
  return !/[?？]/.test(reply) && /^(?:принял|записал|зафиксировал|понял|noted|recorded|got it)(?:[\s,!:.]|$)/i.test(reply.trim());
}

export interface GuardAgentResponseInput {
  result: AgentResult;
  phase: ReturnType<typeof resolvePhase>;
  history: { role: "assistant" | "user"; content: string; ts?: number }[];
  batchText: string;
  listings: Listing[];
  primaryListing: Listing;
}

function selectedListingFromOwnerWords(
  listings: Listing[],
  history: { role: string; content: string }[],
  batchText: string,
): Listing | undefined {
  if (listings.length === 1) return listings[0];
  const ownerTurns = [batchText, ...history.filter((entry) => entry.role === "user").map((entry) => entry.content).reverse()];
  for (const text of ownerTurns) {
    const matches = listings.filter((listing) =>
      new RegExp(`(^|\\D)${String(listing.id).replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?!\\d)`).test(text),
    );
    if (matches.length === 1) return matches[0];
    if (matches.length > 1) return undefined;
  }
  return undefined;
}

/** Applies CRM gates and prevents a live, nonterminal turn from ending on a bare acknowledgement. */
export function finalizeAgentResponse(input: GuardAgentResponseInput) {
  const { result, phase, history, batchText, listings, primaryListing: initialListing } = input;
  const selectedListing = selectedListingFromOwnerWords(listings, history, batchText);
  const primaryListing = selectedListing ?? initialListing;
  const listingUnclear = listings.length > 1 && !selectedListing;
  let proposedActions: AgentAction[] = result.actions;
  const ownerText = [...history.filter((entry) => entry.role === "user").map((entry) => entry.content), batchText].join("\n");
  const lastAssistantText = [...history].reverse().find((entry) => entry.role === "assistant")?.content ?? "";
  proposedActions = listings.length === 1
    ? groundRentalFacts({
        currentMessage: batchText,
        lastAssistantQuestion: lastAssistantText,
        history,
        proposedActions,
        primaryListingId: primaryListing.id,
      })
    : groundedRentalActions(proposedActions, ownerText, lastAssistantText, batchText);
  if (phase === "primary" && listings.length === 1 &&
    /^(да|yes|კი|დიახ|da+)[!. ,]*$/i.test(batchText.trim()) &&
    hasAvailabilityEvidence(ownerText, batchText, lastAssistantText) &&
    primaryListing.rental_terms?.availability_status !== "available" &&
    !proposedActions.some((action) => action.type === "update_rental_terms" && action.data.availability_status === "available")) {
    proposedActions.push({ type: "update_rental_terms", listingId: primaryListing.id, data: { availability_status: "available" } });
  }
  const bareAnswer = /^(?:да|нет|yes|no|da+|net|კი|დიახ|არა|ok|okay|sure)[!.,\s]*$/i.test(batchText.trim());
  const modelConfirmsOwner = result.actions.some((action) => action.type === "set_contact_type" && action.contactType === "owner");
  // A semantic model action is evidence too. Do not discard it merely because
  // the person wrote "ia sobstvenik" instead of a word in our local dictionary.
  const ownerConfirmed = ownerConfirmedFromHistory(history, primaryListing, batchText) ||
    modelConfirmsOwner && !bareAnswer && !isConversationalQuestion(batchText);
  const cooperationConsented = explicitCooperationConsent(batchText, history) ||
    result.actions.some((action) => action.type === "set_crm_status" && action.status === "agreed") &&
    !bareAnswer && !isConversationalQuestion(batchText) && !explicitOwnerStatement(batchText);
  const realtorConfirmed = explicitRealtorStatement(batchText);
  const unavailable = hasExplicitUnavailableEvidence(batchText);
  if (realtorConfirmed) {
    proposedActions = [{ type: "set_contact_type", contactType: "realtor" }];
  }
  if (unavailable) {
    proposedActions = proposedActions.filter((action) =>
      !(action.type === "set_crm_status" && (action.status === "agreed" || action.status === "qualified")) &&
      !(action.type === "set_contact_type" && action.contactType === "owner"),
    );
  }
  if (!hasDefinitiveRefusal(batchText)) {
    proposedActions = proposedActions.filter((action) => !(action.type === "set_crm_status" && action.status === "disagreed"));
  }
  if (phase === "primary") {
    if (ownerConfirmed && !realtorConfirmed && primaryListing.contact_type !== "owner" &&
      !proposedActions.some((action) => action.type === "set_contact_type" && action.contactType === "owner")) {
      proposedActions.push({ type: "set_contact_type", contactType: "owner" });
    }
    if (!ownerConfirmed) {
      proposedActions = proposedActions.filter((action) => !(action.type === "set_contact_type" && action.contactType === "owner"));
    }
    proposedActions = proposedActions.filter((action) => !(action.type === "set_crm_status" && action.status === "agreed"));
    const realtorMentioned = realtorConfirmed || explicitRealtorStatement(ownerText);
    if (ownerConfirmed && cooperationConsented && !realtorMentioned) {
      if (primaryListing.contact_type !== "owner" && !proposedActions.some((action) => action.type === "set_contact_type" && action.contactType === "owner")) {
        proposedActions.push({ type: "set_contact_type", contactType: "owner" });
      }
      proposedActions.push({ type: "set_crm_status", status: "agreed", listingId: primaryListing.id });
    }
  }
  if (listingUnclear) {
    proposedActions = proposedActions.filter((action) => action.type === "set_contact_type");
  } else if (listings.length > 1) {
    proposedActions = proposedActions.filter((action) =>
      action.type === "set_contact_type" || action.listingId === undefined ||
      String(action.listingId) === String(primaryListing.id),
    ).map((action) => action.type === "set_contact_type" ? action : { ...action, listingId: primaryListing.id });
  }

  const phaseTwoAsked = phaseTwoWasAsked(history);
  const phaseTwoAnswered = hasPhaseTwoAnswer(batchText) || proposedActions.some((action) =>
    action.type === "update_deal_info" && Boolean(action.data.window_view?.trim() || action.data.complex_name?.trim()),
  );
  if (phase === "agreed" && phaseTwoAsked && !phaseTwoAnswered) {
    proposedActions = proposedActions.filter((action) => !(action.type === "set_crm_status" && action.status === "qualified"));
  }

  let gate = applyGates(proposedActions, { listings, primaryListingId: primaryListing.id, phase });
  let reply = result.reply?.trim() ?? "";
  // Preserve the model's conversation language for short numbers/transliterated
  // facts instead of unexpectedly switching a Russian conversation to English.
  const responseLanguageText = replyLanguage(batchText) !== "en" || /\b(?:i|i'm|the|what|which|how|please|yes|thanks|owner|months?|rent)\b/i.test(batchText)
    ? batchText : reply || lastAssistantText || batchText;
  const answeringQuestion = isConversationalQuestion(batchText) && !unusableConversationalReply(reply);
  let stopConversation = result.stopConversation;
  const agreedAction = (action: AgentAction) => action.type === "set_crm_status" && action.status === "agreed";
  const qualifiedAction = (action: AgentAction) => action.type === "set_crm_status" && action.status === "qualified";
  const disagreedAction = (action: AgentAction) => action.type === "set_crm_status" && action.status === "disagreed";
  const acceptedAgreed = gate.allowed.some(agreedAction);
  const acceptedQualified = gate.allowed.some(qualifiedAction);
  const rejectedQualification = gate.rejected.find((item) => qualifiedAction(item.action));
  const terminal = gate.allowed.some((action) => disagreedAction(action) || action.type === "set_contact_type" && action.contactType === "realtor");
  if (terminal || acceptedQualified) stopConversation = true;

  if (acceptedAgreed) {
    const merged = mergeActionsOntoListing(primaryListing, gate.allowed, primaryListing.id);
    const missing = qualifiedMissingFields(merged);
    if (!answeringQuestion && (unusableConversationalReply(reply) || acknowledgementWithoutNextStep(reply))) reply = agreedPhaseFallback(responseLanguageText, merged, missing, history);
    stopConversation = false;
  } else if (rejectedQualification) {
    if (!answeringQuestion) reply = qualificationRecoveryReply(responseLanguageText, rejectedQualification.reason);
    stopConversation = false;
  } else if (phase === "agreed" && !terminal && !acceptedQualified) {
    const merged = mergeActionsOntoListing(primaryListing, gate.allowed, primaryListing.id);
    const missing = qualifiedMissingFields(merged);
    const complete = missing.length === 0 &&
      ((phaseTwoWasAsked(history) && phaseTwoAnswered) || (Boolean(merged.window_view?.trim()) && Boolean(merged.complex_name?.trim())));
    const isOwnerQuestion = isConversationalQuestion(batchText);
    if (complete && !isOwnerQuestion && !gate.allowed.some(disagreedAction)) {
      gate = applyGates(
        [...gate.allowed, { type: "set_crm_status", status: "qualified", listingId: primaryListing.id }],
        { listings, primaryListingId: primaryListing.id, phase },
      );
      stopConversation = gate.allowed.some(qualifiedAction);
      if (stopConversation) reply = closingReply(responseLanguageText);
    } else if (!answeringQuestion && (unusableConversationalReply(reply) || acknowledgementWithoutNextStep(reply) || stopConversation && !terminal && !acceptedQualified)) {
      reply = agreedPhaseFallback(responseLanguageText, merged, missing, history);
      stopConversation = false;
    }
    if (!gate.allowed.some(qualifiedAction)) stopConversation = false;
  } else if (phase === "primary" && !terminal && !unavailable) {
    const merged = mergeActionsOntoListing(primaryListing, gate.allowed, primaryListing.id);
    if (gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")) {
      merged.contact_type = "owner";
    }
    const repeatsOwnerQuestion = ownerConfirmed && assistantAskedOwnerOnly(reply);
    if (unusableConversationalReply(reply) || !answeringQuestion && (acknowledgementWithoutNextStep(reply) || repeatsOwnerQuestion)) {
      reply = primaryPhaseFallback(batchText, merged, history, responseLanguageText);
    }
    stopConversation = false;
  }

  if (unavailable && !terminal && phase === "primary") {
    stopConversation = true;
    if (!reply || /[?？]|собственник|владелец|owner|მფლობელ/i.test(reply)) {
      const language = replyLanguage(lastAssistantText || batchText);
      reply = language === "ka" ? "გასაგებია, გმადლობთ. თუ ბინა კვლავ ხელმისაწვდომი გახდება, მოგვწერეთ."
        : language === "ru" ? "Понял, спасибо. Если квартира снова станет доступна, напишите."
          : "Understood, thank you. Please let us know if the apartment becomes available again.";
    }
  }

  if (terminal && !reply) {
    reply = replyLanguage(batchText) === "ru"
      ? "Понял, спасибо."
      : replyLanguage(batchText) === "ka"
        ? "გასაგებია, გმადლობთ."
        : "Understood, thank you.";
  }
  if (gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "realtor")) {
    const language = replyLanguage(batchText);
    reply = language === "ru" ? "Спасибо за уточнение. Мы работаем только с собственниками. Хорошего дня!"
      : language === "ka" ? "გმადლობთ დაზუსტებისთვის. ჩვენ მხოლოდ მეპატრონეებთან ვმუშაობთ. კარგ დღეს გისურვებთ!"
        : "Thanks for clarifying. We work directly with owners only. Have a good day!";
  }
  if (!terminal && !unavailable && phase !== "qualified" && !acceptedQualified && !reply) {
    reply = phase === "agreed"
      ? agreedPhaseFallback(batchText, primaryListing, qualifiedMissingFields(primaryListing), history)
      : primaryPhaseFallback(batchText, primaryListing, history);
    stopConversation = false;
  }
  if (listingUnclear && !terminal && !unavailable) {
    reply = replyLanguage(batchText) === "ka"
      ? "თქვენს ნომერზე რამდენიმე განცხადებაა. რომელ ბინაზე საუბრობთ? მომწერეთ განცხადების ID."
      : replyLanguage(batchText) === "en"
        ? "There are several listings for this number. Which apartment do you mean? Please send the listing ID."
        : "По этому номеру несколько объявлений. О какой квартире речь? Пришлите ID объявления.";
    stopConversation = false;
  }
  if (/исправлен|теперь|правильно|нет[,!:]/i.test(batchText) && /[А-Яа-яЁё]/.test(batchText)) {
    const updates = gate.allowed.filter((action) => action.type === "update_rental_terms");
    const corrections: string[] = [];
    for (const action of updates) {
      if (action.type !== "update_rental_terms") continue;
      if (action.data.price !== undefined && !reply.includes(String(action.data.price))) {
        corrections.push(`цена ${action.data.price} в месяц`);
      }
      if (action.data.minimum_lease_months !== undefined && !reply.includes(String(action.data.minimum_lease_months))) {
        corrections.push(`минимальный срок ${action.data.minimum_lease_months} мес.`);
      }
    }
    if (corrections.length > 0) reply = `Исправил: ${corrections.join(", ")}. ${reply}`.trim();
  }
  return { gate, reply, stopConversation };
}

export async function handleConversationJob(
  input: ConversationJobInput,
  meta: ConversationJobMeta,
  services: Services,
): Promise<RunOutcome> {
  const runId = randomUUID();
  const key = input.conversationKey;
  const { instanceId, chatId } = parseConversationKey(key);
  const log = services.logger.child({ runId, conversationKey: key, instanceId, chatId, jobId: meta.jobId });
  const startedAt = Date.now();
  const isRetry = meta.attemptsMade > 0;
  log.info("run.start");

  if (!isRetry) {
    const currentToken = await services.store.getDebounce(key);
    if (input.token && currentToken !== input.token) {
      log.info("debounce.stale.skip");
      return outcome("skipped", runId);
    }
  }

  const lock = await services.store.acquireLock(key, services.config.conversationLockTtlMs);
  if (!lock) {
    log.warn("lock.busy.reschedule");
    if (isRetry) throw new Error("conversation is locked by another worker");
    await services.store.setDebounce(key, input.token, debounceTtlMs(services.config.messageDebounceMs));
    await services.scheduler.schedule(key, input.token, 1000, input.retryCount ?? 0);
    return outcome("rescheduled", runId);
  }

  const refreshInterval = Math.max(1000, Math.floor(services.config.conversationLockTtlMs / 3));
  let lockLost = false;
  const refreshTimer = setInterval(() => {
    void services.store
      .refreshLock(key, lock.token, services.config.conversationLockTtlMs)
      .then((ok) => {
        if (!ok) lockLost = true;
      })
      .catch(() => {
        lockLost = true;
      });
  }, refreshInterval);

  let batch: NormalizedMessage[] = [];
  let activeBatch: ActiveBatch | null = null;
  let outboundIntent: OutboundIntent | null = null;
  let sendAttempted = false;
  let stage = "init";
  let failed = false;
  let quarantined = false;

  try {
    stage = "buffer.drain";
    batch = await services.store.drainPending(key);
    if (batch.length === 0) {
      log.info("buffer.empty");
      return outcome("empty", runId);
    }
    activeBatch = await services.store.getActiveBatch(key);
    if (!activeBatch) throw new Error("active batch disappeared after drain");
    if (activeBatch.quarantineReason) {
      quarantined = true;
      failed = true;
      log.error({ reason: activeBatch.quarantineReason }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }
    if (activeBatch.outbound && ["sending", "ambiguous"].includes(activeBatch.outbound.state)) {
      quarantined = true;
      failed = true;
      const reason = `outbound intent ${activeBatch.outbound.intentId} is ${activeBatch.outbound.state}; manual reconciliation required`;
      await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
      log.error({ reason }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }
    log.info({ messages: batch.length }, "buffer.drained");

    // A confirmed remote send must be finalized from the durable intent. Do
    // not rerun the LLM or CRM actions when a worker crashed after the send.
    if (activeBatch.outbound?.state === "sent") {
      stage = "outbound.history.recover";
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: activeBatch.outbound.message, ts: Date.now() },
        {
          maxMessages: services.config.conversationHistoryMaxMessages,
          ttlSeconds: services.config.conversationHistoryTtlSeconds,
        },
      );
      if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
        throw new Error("conversation lock lost while recovering sent outbound intent");
      }
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("processed", runId, { reply: activeBatch.outbound.message });
    }

    stage = "batch.resolve";
    const batchText = await resolveBatchText(batch, services);
    if (!batchText) {
      log.warn("batch.no_text");
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("empty", runId);
    }
    if (services.config.logMessageContent) {
      log.debug({ batchText }, "batch.content");
    }

    const instance = services.config.instances.find((i) => i.id === instanceId);
    const phone = batch[0].senderPhone;

    stage = "crm.load";
    const listings = await services.crm.getListingsByPhone(phone);
    log.info({ listingId: listings[0]?.id ?? null, count: listings.length }, "crm.loaded");

    const allowedListings = filterListingsByManager(
      listings,
      instance?.managerId,
      services.config.allowedManagerIds,
    );
    if (allowedListings.length === 0) {
      log.warn({ found: listings.length }, "crm.no_allowed_listings");
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("skipped", runId);
    }

    const primaryListing = allowedListings[0];
    const terminal = allowedListings.every((listing) =>
      isTerminalListing(listing, services.config.terminalCrmStatuses),
    );
    if (terminal) {
      stage = "terminal";
      log.info(
        { crmStatus: primaryListing.crm_status, contactType: primaryListing.contact_type },
        "conversation.terminal",
      );
      await appendHistory(
        services.store,
        key,
        { role: "user", content: batchText, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("terminal", runId);
    }

    const phase = resolvePhase(primaryListing.crm_status);
    log.info({ phase, crmStatus: primaryListing.crm_status }, "conversation.phase");

    stage = "llm";
    const history = await getHistory(services.store, key, {
      maxMessages: services.config.conversationHistoryMaxMessages,
      ttlSeconds: services.config.conversationHistoryTtlSeconds,
    });
    const systemPrompt = buildSystemPrompt({
      crm: { phone, contact: null, listings: allowedListings },
      listings: allowedListings,
      primaryListing,
      phase,
    });

    const { result } = await runAgent(services.llm, log, { systemPrompt, history, batchText });

    stage = "crm.update";
    if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
      throw new Error("conversation lock lost before CRM actions");
    }
    const guarded = finalizeAgentResponse({
      result,
      phase,
      history,
      batchText,
      listings: allowedListings,
      primaryListing,
    });
    const { gate } = guarded;
    const safeReply = guarded.reply;
    const safeStopConversation = guarded.stopConversation;
    for (const rejectedAction of gate.rejected) {
      log.warn(
        { action: rejectedAction.action.type, reason: rejectedAction.reason },
        "action.gate.rejected",
      );
    }
    const executed = await executeActions(gate.allowed, {
      crm: services.crm,
      logger: log,
      debug: services.debug,
      phone,
      primaryListingId: primaryListing.id,
    });

    await appendHistory(
      services.store,
      key,
      { role: "user", content: batchText, ts: Date.now() },
      { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
    );

    stage = "crm.reply";
    const reply = safeReply;
    if (reply) {
      if (services.config.logMessageContent) log.debug({ reply }, "crm.reply.content");
      stage = "outbound.intent";
      outboundIntent = await services.store.prepareOutboundIntent({
        conversationKey: key,
        batchKey: activeBatch.batchKey,
        instanceId,
        chatId,
        message: reply,
      });
      let sentResult: { idMessage?: string; mocked: boolean } | undefined;
      if (outboundIntent.state === "sent") {
        log.warn({ intentId: outboundIntent.intentId }, "crm.reply.already_sent");
      } else if (outboundIntent.state === "prepared") {
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
          throw new Error("conversation lock lost before outbound claim");
        }
        const claimed = await services.store.claimOutboundIntent(key, outboundIntent.intentId);
        if (!claimed || claimed.state !== "sending") {
          quarantined = true;
          failed = true;
          const reason = `outbound intent ${outboundIntent.intentId} could not be exclusively claimed; manual reconciliation required`;
          await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
          return outcome("quarantined", runId);
        }
        outboundIntent = claimed;
        sendAttempted = true;
        log.info({ intentId: outboundIntent.intentId }, "crm.reply.started");
        sentResult = await services.sender.sendMessage({
          instanceId: outboundIntent.instanceId,
          chatId: outboundIntent.chatId,
          message: outboundIntent.message,
        });
        stage = "outbound.persist";
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
          throw new Error("conversation lock lost after outbound response");
        }
        await services.store.markOutboundSent(key, outboundIntent.intentId, sentResult.idMessage);
        outboundIntent = { ...outboundIntent, state: "sent", idMessage: sentResult.idMessage };
        log.info({ intentId: outboundIntent.intentId }, "crm.reply.completed");
      } else if (outboundIntent.state === "sending" || outboundIntent.state === "ambiguous") {
        quarantined = true;
        failed = true;
        const reason = `outbound intent ${outboundIntent.intentId} is ${outboundIntent.state}; manual reconciliation required`;
        await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
        return outcome("quarantined", runId);
      }
      const sentReply = outboundIntent.message;
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: sentReply, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
    }

    stage = "batch.ack";
    if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
      throw new Error("conversation lock lost before batch acknowledgement");
    }
    await services.store.ackBatch(key, activeBatch.batchKey);
    log.info(
      { duration: Date.now() - startedAt, actions: executed.length, stopConversation: safeStopConversation },
      "run.completed",
    );
    return outcome("processed", runId, {
      executedActions: executed,
      reply,
      stopConversation: safeStopConversation,
    });
  } catch (error) {
    failed = true;
    const attempt = meta.attemptsMade + 1;
    const retryCount = input.retryCount ?? 0;
    log.error(
      {
        stage,
        attempt,
        maxAttempts: meta.maxAttempts,
        err: (error as Error).message,
      },
      "run.failed",
    );

    const currentActive = await services.store.getActiveBatch(key).catch(() => null);
    // A stale worker must never quarantine or mutate a newer batch that took
    // over after its lock expired. Only inspect the current store state when
    // its batch fence still matches the batch this worker claimed.
    const ownsActiveBatch = Boolean(activeBatch && currentActive?.batchKey === activeBatch.batchKey);
    const currentOutbound = ownsActiveBatch ? currentActive?.outbound ?? outboundIntent : outboundIntent;
    if (currentOutbound && (sendAttempted || currentOutbound.state === "sent")) {
      const reason = `outbound processing failed at ${stage}: ${(error as Error).message}; manual reconciliation required before resuming`;
      if (currentOutbound.state === "sending") {
        await services.store
          .markOutboundAmbiguous(key, currentOutbound.intentId, reason)
          .catch(() => undefined);
      }
      await services.store.quarantineBatch(key, reason, activeBatch?.batchKey).catch(() => undefined);
      quarantined = true;
      failed = true;
      log.error({ reason, intentId: currentOutbound.intentId }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }

    const isFinalAttempt = attempt >= meta.maxAttempts;
    if (isFinalAttempt && retryCount < MAX_MANUAL_RETRIES) {
      const nextToken = randomUUID();
      const delay = 1000 * 2 ** retryCount;
      await services.store.setDebounce(key, nextToken, debounceTtlMs(services.config.messageDebounceMs));
      await services.scheduler.schedule(key, nextToken, delay, retryCount + 1);
      log.warn({ retryCount: retryCount + 1, delay }, "run.retry.scheduled");
      return outcome("rescheduled", runId);
    }

    if (isFinalAttempt) {
      log.error({ stage, retryCount }, "run.failed.permanent");
      return outcome("failed", runId);
    }

    throw error;
  } finally {
    clearInterval(refreshTimer);
    await services.store.releaseLock(key, lock.token).catch(() => undefined);

    if (!failed && !quarantined) {
      try {
        const remaining = await services.store.pendingCount(key);
        if (remaining > 0) {
          const nextToken = randomUUID();
          await services.store.setDebounce(key, nextToken, debounceTtlMs(services.config.messageDebounceMs));
          await services.scheduler.schedule(key, nextToken, services.config.messageDebounceMs, input.retryCount ?? 0);
        }
      } catch (error) {
        log.warn({ err: (error as Error).message }, "reschedule.after_run.failed");
      }
    }
  }
}
