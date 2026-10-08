import { AgentAction } from "../../src/agent/schemas";
import { Listing } from "../../src/types";
import { TestInteraction } from "../helpers/owner-dialogue-server";

export interface OwnerDialogueTurn {
  ownerText: string;
  /** Separate inbound messages coalesced by the debounce buffer in this turn. */
  ownerMessages?: string[];
  plannedReply: string;
  finalReply?: string;
  actions: AgentAction[];
  selectedListingId?: string | number;
  expect: {
    status?: string;
    contactType?: string | null;
    listingId?: string | number;
    fields?: Record<string, unknown>;
    /** Live-provider alternatives for semantic CRM fields; scripted replay stays exact. */
    liveFields?: Record<string, unknown[]>;
    absentFields?: string[];
    replyIncludes?: string[];
    replyExcludes?: string[];
    /** Broader semantic expectations for a configured LLM, when wording can vary by model. */
    liveReplyIncludes?: string[];
    stopConversation?: boolean;
    sendCount?: number;
    writeCount?: number;
    writeSignatures?: string[];
    runStatus?: "processed" | "failed" | "terminal" | "skipped";
    runModel?: boolean;
  };
  failCrmWrite?: boolean;
  duplicateWebhook?: boolean;
}

export interface OwnerDialogueScenario {
  id: string;
  title: string;
  listingIds?: Array<string | number>;
  initialStatus?: string;
  initialContactType?: string | null;
  initialRentalTerms?: Partial<NonNullable<Listing["rental_terms"]>>;
  initialInteractions?: TestInteraction[];
  turns: OwnerDialogueTurn[];
  alternates?: OwnerDialogueScenario[];
}

const property = (id: string | number, overrides: Partial<Listing> = {}): Listing => ({
  id, title: `Batumi flat ${id}`, crm_status: "sent", contact_type: null, assigned_manager_id: 2,
  assigned_manager_is_ai: true, city: "Batumi", address: id === 101 ? "Kobaladze 12" : `Demo Street ${id}`,
  price: "900", currency: "USD", rental_terms: { listing_id: id, price: 900, currency: "USD", price_period: "month", minimum_lease_months: null, availability_status: "available" },
  ...overrides,
});
const action = (value: AgentAction) => value;

/** Each owner input, model action proposal, and expected post-turn state is explicit. */
export const ownerDialogueCorpus: OwnerDialogueScenario[] = [
  {
    id: "initial-outreach-greeting-net", title: "Greeting and bare net decline the actual first outreach and stop",
    initialStatus: "new",
    initialRentalTerms: { price: 450, availability_status: "unknown" },
    initialInteractions: [{ id: "outreach-net", text: "Добрый день! Наткнулся на ваше объявление «Сдается в аренду 1-комнатная квартира площадью 44 м² в Батуми, Aisi. Цена аренды — $450 в месяц». Объявление ещё актуально? Интересует долгосрочная аренда", sender: "agent", direction: "outbound", sent_at: "2026-10-08T07:34:21Z", whatsapp_instance_id: "acceptance-instance" }],
    turns: [
      { ownerText: "dobri den\nnet", ownerMessages: ["dobri den", "net"], plannedReply: "Ponyal, spasibo za otvet. Khoroshego dnya!", actions: [action({ type: "update_deal_info", listingId: 101, data: { agent_notes: "На первое обращение об актуальности объявления и долгосрочной аренде ответил: dobri den / net. Причина отказа не указана." } }), action({ type: "set_crm_status", status: "disagreed" })], expect: { status: "disagreed", contactType: null, fields: { "rental_terms.availability_status": "unknown" }, replyExcludes: ["?", "собственник", "sobstvennik", "owner"], stopConversation: true, sendCount: 1, runModel: true } },
      { ownerText: "spasibo", plannedReply: "", actions: [], expect: { status: "disagreed", sendCount: 1, runStatus: "terminal", runModel: false } },
    ],
  },
  {
    id: "bare-yes-current-rental", title: "Bare yes answers only the actual rental question",
    initialInteractions: [{ id: "outreach-1", text: "Здравствуйте! Ваша квартира ещё сдаётся на длительный срок?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" }],
    initialRentalTerms: { availability_status: "unknown" },
    turns: [{ ownerText: "Да", plannedReply: "Понял, квартира доступна. Вы собственник этой квартиры?", actions: [action({ type: "update_rental_terms", listingId: 101, data: { availability_status: "available" } })], expect: { status: "sent", contactType: null, fields: { "rental_terms.availability_status": "available" }, replyIncludes: ["собственник"], replyExcludes: ["готовы сотрудничать"], sendCount: 1, writeCount: 2, writeSignatures: ["rental:101:availability_status", "reply"] } }],
  },
  {
    id: "all-facts-first-reply", title: "One message supplies owner, consent, price, and term",
    initialInteractions: [
      { id: "availability-confirmed", text: "Да, квартира сдаётся на длительный срок.", sender: "owner", direction: "inbound", sent_at: "2026-10-01T09:59:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "outreach-2", text: "Вы собственник и готовы сотрудничать?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    initialRentalTerms: { availability_status: "available" },
    turns: [{ ownerText: "Я собственник, можно работать: 900 USD в месяц, минимум год.", plannedReply: "Спасибо, записал условия квартиры. Хорошего дня!", actions: [
      action({ type: "set_contact_type", contactType: "owner" }), action({ type: "set_crm_status", status: "agreed" }),
      action({ type: "update_rental_terms", listingId: 101, data: { price: 900, currency: "USD", minimum_lease_months: 12 } }), action({ type: "set_crm_status", status: "qualified" }),
    ], expect: { status: "qualified", contactType: "owner", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, stopConversation: true, replyExcludes: ["опубликовали", "готовим публикацию"], sendCount: 1, writeCount: 5, writeSignatures: ["contact_type:owner", "rental:101:minimum_lease_months", "status:agreed", "status:qualified", "reply"] } }],
  },
  {
    id: "two-yes-meanings", title: "Separate yes answers to role and cooperation",
    initialRentalTerms: { availability_status: "available" },
    initialInteractions: [
      { id: "availability-confirmed-3", text: "Да, квартира сдаётся на длительный срок и будет доступна.", sender: "owner", direction: "inbound", sent_at: "2026-10-01T09:59:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "outreach-3", text: "Вы собственник этой квартиры?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    turns: [
      { ownerText: "Да", plannedReply: "Готовы сотрудничать с нами по этой квартире?", actions: [action({ type: "set_contact_type", contactType: "owner" })], expect: { status: "sent", contactType: "owner", replyIncludes: ["сотрудничать"], sendCount: 1, writeCount: 2, writeSignatures: ["contact_type:owner", "reply"] } },
      { ownerText: "Да", plannedReply: "Спасибо. Цена 900 USD в месяц, верно?", actions: [action({ type: "set_crm_status", status: "agreed" })], expect: { status: "agreed", contactType: "owner", sendCount: 2, writeCount: 4, writeSignatures: ["status:agreed", "reply"] } },
    ],
  },
  {
    id: "complete-outreach-to-qualified", title: "Complete ordinary conversation from real outreach through qualified and silence",
    initialRentalTerms: { availability_status: "unknown", price: 900, currency: "USD", minimum_lease_months: null },
    initialInteractions: [{ id: "outreach-complete", text: "Здравствуйте! Ваша квартира ещё сдаётся на длительный срок?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" }],
    turns: [
      { ownerText: "Да", plannedReply: "Спасибо. Вы собственник этой квартиры?", actions: [action({ type: "update_rental_terms", listingId: 101, data: { availability_status: "available" } })], expect: { status: "sent", contactType: null, fields: { "rental_terms.availability_status": "available" }, replyIncludes: ["собственник"], sendCount: 1, writeCount: 2, writeSignatures: ["rental:101:availability_status", "reply"] } },
      { ownerText: "Да", plannedReply: "Готовы сотрудничать с нами по этой квартире?", actions: [action({ type: "set_contact_type", contactType: "owner" })], expect: { status: "sent", contactType: "owner", replyIncludes: ["сотрудничать"], sendCount: 2, writeCount: 4, writeSignatures: ["contact_type:owner", "reply"] } },
      { ownerText: "Да", plannedReply: "В объявлении указана цена 900 USD в месяц. Подтверждаете?", actions: [action({ type: "set_crm_status", status: "agreed" })], expect: { status: "agreed", contactType: "owner", replyIncludes: ["цена"], sendCount: 3, writeCount: 6, writeSignatures: ["status:agreed", "reply"] } },
      { ownerText: "Да, верно", plannedReply: "Какой минимальный срок аренды?", actions: [], expect: { status: "agreed", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD" }, replyIncludes: ["минимальн"], sendCount: 4, writeCount: 7, writeSignatures: ["reply"] } },
      { ownerText: "Минимум год", plannedReply: "Спасибо, записал условия. Хорошего дня!", actions: [action({ type: "update_rental_terms", listingId: 101, data: { minimum_lease_months: 12 } }), action({ type: "set_crm_status", status: "qualified" })], expect: { status: "qualified", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, stopConversation: true, sendCount: 5, writeCount: 10, writeSignatures: ["rental:101:minimum_lease_months", "status:qualified", "reply"] } },
      { ownerText: "Спасибо", plannedReply: "", actions: [], expect: { status: "qualified", runStatus: "terminal", runModel: false, sendCount: 5, writeCount: 10 } },
    ],
  },
  {
    id: "rental-terms-in-parts", title: "Partial rental facts do not prematurely qualify",
    initialStatus: "agreed", initialContactType: "owner",
    initialRentalTerms: { price: null, currency: null, minimum_lease_months: null },
    turns: [
      { ownerText: "Минимум на год", plannedReply: "Понял, минимальный срок — год. Какая актуальная цена в месяц и валюта?", actions: [action({ type: "update_rental_terms", listingId: 101, data: { minimum_lease_months: 12 } })], expect: { status: "agreed", fields: { "rental_terms.minimum_lease_months": 12 }, replyIncludes: ["цена"], sendCount: 1, writeCount: 2, writeSignatures: ["rental:101:minimum_lease_months", "reply"] } },
      { ownerText: "900 долларов в месяц", plannedReply: "Спасибо, записал цену 900 USD и минимальный срок год. Хорошего дня!", actions: [action({ type: "update_rental_terms", listingId: 101, data: { price: 900, currency: "USD" } }), action({ type: "set_crm_status", status: "qualified" })], expect: { status: "qualified", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, stopConversation: true, sendCount: 2, writeCount: 5, writeSignatures: ["rental:101:currency,price", "status:qualified", "reply"] } },
    ],
  },
  {
    id: "optional-view-question", title: "Sea view answer does not trigger hidden qualification requirements",
    initialStatus: "agreed", initialContactType: "owner",
    initialRentalTerms: { minimum_lease_months: 12 },
    initialInteractions: [{ id: "view-question", text: "Какой вид из окон? В каком ЖК квартира?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" }],
    turns: [{ ownerText: "Вид на море", plannedReply: "Спасибо, вид на море записал. Подскажите, в каком ЖК квартира?", actions: [action({ type: "update_deal_info", listingId: 101, data: { window_view: "море" } })], expect: { status: "agreed", fields: { window_view: "море" }, liveFields: { window_view: ["море", "Вид на море"] }, replyIncludes: ["ЖК"], liveReplyIncludes: ["вид на море"], sendCount: 1, writeCount: 2, writeSignatures: ["deal:101:window_view", "reply"] } }],
  },
  {
    id: "future-availability", title: "December availability stays a future date phrase",
    initialRentalTerms: { availability_status: "unknown" },
    turns: [{ ownerText: "Свободна с декабря", plannedReply: "Понял, квартира будет свободна с декабря. Вы собственник?", actions: [action({ type: "update_rental_terms", listingId: 101, data: { lease_terms_notes: "Свободна с декабря" } })], expect: { status: "sent", fields: { "rental_terms.lease_terms_notes": "Свободна с декабря", "rental_terms.availability_status": "unknown" }, absentFields: ["rental_terms.available_from"], replyIncludes: ["декабря"], sendCount: 1, writeCount: 2 } }],
  },
  {
    id: "price-correction", title: "Owner correction replaces the old selected listing price",
    initialStatus: "agreed", initialContactType: "owner",
    turns: [{ ownerText: "Цена теперь 800, не 900", plannedReply: "Понял, исправил цену на 800. Это USD в месяц?", actions: [action({ type: "update_rental_terms", listingId: 101, data: { price: 800 } })], expect: { status: "agreed", fields: { "rental_terms.price": 800 }, sendCount: 1, writeCount: 2 } }],
  },
  {
    id: "language-variants", title: "Russian transliteration, Georgian, and English keep their own language",
    initialRentalTerms: { minimum_lease_months: null, availability_status: "available" },
    initialInteractions: [
      { id: "language-availability-confirmed", text: "Да, квартира сдаётся на длительный срок.", sender: "owner", direction: "inbound", sent_at: "2026-10-01T09:59:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "language-role-question", text: "Вы собственник этой квартиры?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    turns: [
      { ownerText: "Da, ia sobstvennik", plannedReply: "Ponyal, spasibo. Gotovy sotrudnichat?", actions: [action({ type: "set_contact_type", contactType: "owner" })], expect: { status: "sent", contactType: "owner", replyIncludes: ["sotrudnichat"], sendCount: 1, writeCount: 2 } },
      { ownerText: "დიახ, თანამშრომლობა შეიძლება", plannedReply: "მადლობა. ფასი თვეში 900 USD-ია, სწორია?", actions: [action({ type: "set_crm_status", status: "agreed" })], expect: { status: "agreed", replyIncludes: ["მადლობა"], sendCount: 2, writeCount: 4 } },
      { ownerText: "900 USD per month, at least one year", plannedReply: "Thanks, I noted the monthly price and minimum term. Have a good day!", actions: [action({ type: "update_rental_terms", listingId: 101, data: { price: 900, currency: "USD", minimum_lease_months: 12 } }), action({ type: "set_crm_status", status: "qualified" })], expect: { status: "qualified", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, replyIncludes: ["Thanks"], stopConversation: true, sendCount: 3, writeCount: 7 } },
    ],
  },
  {
    id: "multiple-listings", title: "Ask for address before writing when phone has two flats",
    listingIds: [101, 202],
    turns: [
      { ownerText: "Я собственник и готов сотрудничать. Цена 850 USD в месяц, минимум год", plannedReply: "У вас несколько квартир. Подскажите, пожалуйста, адрес той, по которой вы сообщаете условия?", actions: [], expect: { status: "sent", contactType: null, replyIncludes: ["адрес"], liveReplyIncludes: ["listing-address-choice"], replyExcludes: ["ID", "claims-crm-write"], sendCount: 1, writeCount: 1, writeSignatures: ["reply"] } },
      { ownerText: "Это Kobaladze 12", plannedReply: "Спасибо, записал цену и минимальный срок по квартире на Kobaladze 12. Потребуется проверка менеджера.", selectedListingId: 101, actions: [action({ type: "set_contact_type", contactType: "owner" }), action({ type: "update_rental_terms", listingId: 101, data: { price: 850, currency: "USD", minimum_lease_months: 12 } }), action({ type: "update_deal_info", listingId: 101, data: { agent_notes: "Нужна проверка менеджера: у контакта несколько квартир, scope квалификации не определён" } }), action({ type: "set_crm_status", status: "agreed", listingId: 101 })], expect: { status: "agreed", listingId: 101, fields: { "rental_terms.price": 850, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12, agent_notes: "Нужна проверка менеджера: у контакта несколько квартир, scope квалификации не определён" }, liveFields: { agent_notes: ["Нужна проверка менеджера: у контакта несколько квартир, scope квалификации не определён", "Нужна проверка менеджера: у контакта несколько квартир, scope квалификации не определён."] }, absentFields: ["window_view"], replyIncludes: ["Kobaladze 12"], replyExcludes: ["asks-price", "asks-minimum-term"], sendCount: 2, writeCount: 6, writeSignatures: ["contact_type:owner", "rental:101:minimum_lease_months,price", "deal:101:agent_notes", "status:agreed", "reply"] } },
    ],
  },
  {
    id: "commission-and-identity", title: "Answer who we are and commission, then ask one missing fact",
    initialStatus: "agreed", initialContactType: "owner",
    initialRentalTerms: { price: 900, currency: "USD", price_period: "month", availability_status: "available", minimum_lease_months: null },
    initialInteractions: [
      { id: "commission-owner-confirmation", text: "Да, квартира всё ещё сдаётся на длительный срок, цена 900 USD в месяц.", sender: "owner", direction: "inbound", sent_at: "2026-10-01T09:58:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "commission-minimum-term-question", text: "Какой минимальный срок аренды?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T09:59:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    turns: [
      { ownerText: "Кто вы и какая комиссия?", plannedReply: "Мы агентство недвижимости и помогаем сдавать квартиры. Комиссия зависит от условий и обсуждается заранее. Какая минимальная длительность аренды?", actions: [], expect: { status: "agreed", replyIncludes: ["агентств", "комисси", "минимальн"], sendCount: 1, writeCount: 1 } },
      { ownerText: "Минимум год", plannedReply: "Спасибо, записал минимальный срок — год. Хорошего дня!", actions: [action({ type: "update_rental_terms", listingId: 101, data: { minimum_lease_months: 12 } }), action({ type: "set_crm_status", status: "qualified" })], expect: { status: "qualified", fields: { "rental_terms.minimum_lease_months": 12 }, stopConversation: true, sendCount: 2, writeCount: 4 } },
    ],
  },
  {
    id: "terminal-owner-branches", title: "Realtor, refusal, and already-rented branches terminate",
    turns: [
      { ownerText: "Я риелтор, представляю владельца", plannedReply: "Спасибо за уточнение. Мы работаем напрямую с собственниками.", actions: [action({ type: "set_contact_type", contactType: "realtor" })], expect: { contactType: "realtor", status: "sent", stopConversation: true, replyExcludes: ["собственник этой квартиры?"], sendCount: 1, writeCount: 2 } },
    ],
    alternates: [
      { id: "refusal", title: "Explicit refusal ends the dialogue without qualification", turns: [{ ownerText: "Нет, не хочу сдавать", plannedReply: "Понял, спасибо за ответ. Хорошего дня!", actions: [action({ type: "set_crm_status", status: "disagreed" })], expect: { status: "disagreed", contactType: null, stopConversation: true, sendCount: 1, writeCount: 2 } }] },
      { id: "already-rented", title: "Already rented listing terminates without qualification", turns: [{ ownerText: "Уже сдана", plannedReply: "Понял, спасибо, что сообщили. Хорошего дня!", actions: [action({ type: "update_rental_terms", listingId: 101, data: { availability_status: "rented" } })], expect: { status: "sent", fields: { "rental_terms.availability_status": "rented" }, stopConversation: true, sendCount: 1, writeCount: 2 } }] },
    ],
  },
  {
    id: "manager-takeover", title: "A human manager's latest outbound message stops Batymi",
    initialInteractions: [
      { id: "owner-old", text: "А сколько стоит?", sender: "owner", direction: "inbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "manager-reply", text: "Здравствуйте, я менеджер, сейчас уточню условия.", sender: "manager", direction: "outbound", sent_at: "2026-10-01T10:01:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    turns: [{ ownerText: "Хорошо, жду", plannedReply: "", actions: [], expect: { sendCount: 0, runModel: false, runStatus: "skipped" } }],
  },
  {
    id: "qualified-silence", title: "One closing reply, then save and ignore later webhook",
    initialStatus: "agreed", initialContactType: "owner",
    initialRentalTerms: { minimum_lease_months: 12 },
    turns: [
      { ownerText: "Подтверждаю: 900 USD в месяц, минимум год", plannedReply: "Спасибо, записал условия. Хорошего дня!", actions: [action({ type: "set_crm_status", status: "qualified" })], expect: { status: "qualified", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, stopConversation: true, sendCount: 1, writeCount: 2 } },
      { ownerText: "Спасибо", plannedReply: "", actions: [], expect: { status: "qualified", sendCount: 1, runModel: false, runStatus: "terminal" } },
    ],
  },
  {
    id: "crm-write-failure", title: "CRM failure does not send a false confirmation or qualify",
    initialRentalTerms: { price: null, currency: null, minimum_lease_months: null },
    initialInteractions: [
      { id: "crm-failure-availability-confirmed", text: "Да, квартира сдаётся на длительный срок.", sender: "owner", direction: "inbound", sent_at: "2026-10-01T09:59:00Z", whatsapp_instance_id: "acceptance-instance" },
      { id: "crm-failure-role-question", text: "Вы собственник этой квартиры?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" },
    ],
    turns: [{ ownerText: "Я собственник, можно работать, цена 900 USD в месяц, минимум год", plannedReply: "Записал условия.", actions: [action({ type: "set_contact_type", contactType: "owner" }), action({ type: "set_crm_status", status: "agreed" }), action({ type: "update_rental_terms", listingId: 101, data: { price: 900, currency: "USD", minimum_lease_months: 12 } }), action({ type: "set_crm_status", status: "qualified" })], failCrmWrite: true, expect: { status: "qualified", contactType: "owner", fields: { "rental_terms.price": 900, "rental_terms.currency": "USD", "rental_terms.minimum_lease_months": 12 }, sendCount: 1, writeCount: 6, writeSignatures: ["contact_type:owner", "contact_type:owner", "rental:101:currency,minimum_lease_months,price", "status:agreed", "status:qualified", "reply"], runStatus: "processed", stopConversation: true } }],
  },
  {
    id: "duplicate-webhook", title: "Repeated inbound webhook and sent-intent recovery never double-send",
    initialInteractions: [{ id: "owner-question", text: "Вы собственник этой квартиры?", sender: "agent", direction: "outbound", sent_at: "2026-10-01T10:00:00Z", whatsapp_instance_id: "acceptance-instance" }],
    turns: [{ ownerText: "Да, я собственник", plannedReply: "Готовы сотрудничать?", actions: [action({ type: "set_contact_type", contactType: "owner" })], duplicateWebhook: true, expect: { status: "sent", contactType: "owner", sendCount: 1, writeCount: 2, writeSignatures: ["contact_type:owner", "reply"] } }],
  },
];

export function makeScenarioListings(scenario: OwnerDialogueScenario): Listing[] {
  const ids = scenario.listingIds ?? [101];
  return ids.map((id) => property(id, {
    crm_status: scenario.initialStatus ?? "sent",
    contact_type: scenario.initialContactType ?? null,
    rental_terms: { ...property(id).rental_terms, ...scenario.initialRentalTerms },
  }));
}
