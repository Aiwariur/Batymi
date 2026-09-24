import { Listing, RentalTerms } from "../../src/types";

export interface ExpectedAction {
  type: "set_contact_type" | "update_deal_info" | "update_rental_terms" | "set_crm_status";
  contactType?: string;
  status?: string;
  data?: Record<string, unknown>;
}

export type ScenarioCRMState = Partial<Listing> & { rentalTerms?: Partial<RentalTerms> };

export interface ExpectedTurn {
  /** CRM status at the start/end of this turn. Use these to pin phase transitions. */
  crmStatusBefore?: string;
  crmStatusAfter?: string;
  /** Substrings that must appear in this turn's reply, case-insensitive. */
  replyMustContain?: string[];
  /** Actions required on this exact turn, rather than anywhere in the conversation. */
  requiredActions?: ExpectedAction[];
  /** Actions forbidden on this exact turn. */
  forbiddenActions?: string[];
  /** Fields that must match the CRM snapshot immediately after this turn. */
  expectedCRMState?: ScenarioCRMState;
}

export interface ExpectedTransitionReply {
  fromStatus: string;
  toStatus: string;
  replyMustContain: string[];
}

export interface ConversationScenario {
  name: string;
  initialCRMState: ScenarioCRMState;
  /** Exact prior turns needed to reproduce a live conversation state. */
  priorHistory?: Array<{ role: "user" | "assistant"; content: string }>;
  messages: string[];
  expectedActions: ExpectedAction[];
  forbiddenActions: string[];
  /** Антигаллюцинация: ключи data, которые не должны появиться в actions указанного типа. */
  forbiddenDataKeys?: Record<string, string[]>;
  /** Подстроки (без учёта регистра), обязанные быть в последнем ответе собственнику. */
  finalReplyMustContain?: string[];
  /** Turn-indexed assertions; omitted entries impose no extra per-turn assertion. */
  expectedTurns?: ExpectedTurn[];
  /** Require the response that advances CRM state to include the next-step questions. */
  transitionReplies?: ExpectedTransitionReply[];
  /** Отключает инвариант «диалог не обрывается»: последний ответ обязан содержать вопрос. */
  noQuestionOk?: boolean;
  expectedFinalCRMState?: ScenarioCRMState;
  stopConversation?: boolean;
  note?: string;
}

export const baseListing: Listing = {
  id: 101,
  crm_status: "delivered",
  phone: "+995555000001",
  contact_name: "Owner",
  contact_type: "potential_owner",
  address: "Batumi, Kobaladze 12",
  district: "New Boulevard",
  city: "Batumi",
  rooms: "2",
  area: "58",
  floor: "12",
  price: 900,
  currency: "USD",
  url: "https://example.com/flat/101",
  window_view: null,
  complex_name: null,
  cadastral_code: null,
  description:
    "Светлая квартира с ремонтом, балкон, кондиционер. В доме бассейн, спортзал и закрытая парковка.",
  options: ["Балкон", "Бассейн", "Спортзал", "Лифт"],
  agent_notes: null,
  assigned_manager_id: 2,
  is_active: true,
  rental_terms: {
    listing_id: 101,
    price: 900,
    currency: "USD",
    transaction_type: "rent_long_term",
    price_period: "month",
    deposit_amount: null,
    prepayment_months: null,
    minimum_lease_months: null,
    availability_status: "unknown",
    available_from: null,
    lease_terms_notes: null,
    commission_type: null,
    commission_value: null,
    commission_payer: "unknown",
    commission_notes: null,
  },
};

function scenario(input: ConversationScenario): ConversationScenario {
  return input;
}

export const scenarios: ConversationScenario[] = [
  scenario({
    name: "live-regression-availability-da-not-agreement",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [
      { role: "assistant", content: "Здравствуйте! Квартира ещё сдаётся на длительный срок?" },
    ],
    messages: ["da"],
    expectedActions: [
      { type: "update_rental_terms", data: { availability_status: "available" } },
    ],
    forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed", "set_crm_status:qualified"],
    forbiddenDataKeys: { update_rental_terms: ["commission_type", "commission_payer"] },
    expectedTurns: [{ crmStatusBefore: "delivered", crmStatusAfter: "delivered", replyMustContain: ["собственник"] }],
    expectedFinalCRMState: { crm_status: "delivered", contact_type: "potential_owner", rentalTerms: { availability_status: "available" } },
    note: "Live screenshot: bare da to availability cannot grant ownership or cooperation, and reply must actually ask the next question.",
  }),
  scenario({
    name: "owner-simple",
    initialCRMState: {},
    messages: ["Да, квартира сдаётся", "Я собственник", "Готовы работать"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "set_crm_status", status: "agreed" },
    ],
    forbiddenActions: ["set_crm_status:qualified"],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer"],
    },
    finalReplyMustContain: ["вид из окон", "жк"],
    note: "Явное согласие переводит в agreed тем же ходом; reply — пачка фазы 2, не «Принял».",
  }),
  scenario({
    name: "owner-consent-immediate-agreed",
    initialCRMState: {},
    messages: ["Да, собственник, готов работать с вами"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "set_crm_status", status: "agreed" },
    ],
    forbiddenActions: ["set_crm_status:qualified", "set_crm_status:disagreed"],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer"],
    },
    finalReplyMustContain: ["вид из окон"],
    note: "Согласие + условия одним сообщением: agreed сразу, reply — пачка фазы 2.",
  }),
  scenario({
    name: "realtor",
    initialCRMState: {},
    messages: ["Я не собственник, я агент"],
    expectedActions: [{ type: "set_contact_type", contactType: "realtor" }],
    forbiddenActions: ["set_crm_status:qualified", "update_rental_terms"],
    stopConversation: true,
  }),
  scenario({
    name: "realtor-late-disclosure",
    initialCRMState: {},
    messages: ["Да, сдаётся", "Вообще я риелтор этой квартиры"],
    expectedActions: [{ type: "set_contact_type", contactType: "realtor" }],
    forbiddenActions: ["set_crm_status:qualified"],
    stopConversation: true,
  }),
  scenario({
    name: "owner-gives-everything-at-once",
    initialCRMState: {},
    messages: [
      "Да, я собственник, можно работать. 900 долларов в месяц, на год, депозит 900. Вид на море, ЖК Orbi City",
    ],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_rental_terms", data: { minimum_lease_months: 12, deposit_amount: 900 } },
      { type: "update_deal_info", data: { window_view: "море" } },
      { type: "update_deal_info", data: { complex_name: "Orbi City" } },
      { type: "set_crm_status", status: "agreed" },
    ],
    forbiddenActions: ["set_crm_status:qualified", "set_crm_status:disagreed"],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer"],
    },
    note: "All facts from one message must be extracted; the reply asks the next still-missing fact.",
  }),
  scenario({
    name: "owner-short-answers",
    initialCRMState: { rentalTerms: { price: null } },
    messages: ["Да", "Собственник", "Можно", "900 в месяц", "Море", "Orbi"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_rental_terms" },
      { type: "update_deal_info" },
    ],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer"],
    },
  }),
  scenario({
    name: "owner-changes-price",
    initialCRMState: { rentalTerms: { price: 850 } },
    messages: ["Цена теперь 950 в месяц"],
    expectedActions: [{ type: "update_rental_terms", data: { price: 950 } }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
  }),
  scenario({
    name: "owner-no-complex",
    initialCRMState: {},
    messages: ["Квартира без ЖК, обычный дом"],
    expectedActions: [{ type: "update_deal_info", data: { complex_name: "нет ЖК" } }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
  }),
  scenario({
    name: "owner-gives-commission-percent",
    initialCRMState: {},
    messages: ["Комиссия 50% с первого месяца, платит собственник"],
    expectedActions: [
      { type: "update_rental_terms", data: { commission_type: "percent_month", commission_payer: "owner" } },
    ],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-deposit-months",
    initialCRMState: {},
    messages: ["Депозит один месяц, минимальный срок 12 месяцев"],
    expectedActions: [{ type: "update_rental_terms", data: { minimum_lease_months: 12 } }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "prepayment_months"],
    },
  }),
  scenario({
    name: "owner-refuses",
    initialCRMState: {},
    messages: ["Нет, не хочу сотрудничать, не интересно", "Нет, точно не нужно, не пишите"],
    expectedActions: [{ type: "set_crm_status", status: "disagreed" }],
    forbiddenActions: ["set_crm_status:qualified"],
    stopConversation: true,
  }),
  scenario({
    name: "owner-soft-objection",
    initialCRMState: {},
    messages: ["Не уверен, зачем мне агентство"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "First doubt must not be treated as final refusal.",
  }),
  scenario({
    name: "owner-availability-from-month",
    initialCRMState: {},
    messages: ["Квартира будет свободна с октября"],
    expectedActions: [{ type: "update_rental_terms" }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
    note: "Non-ISO availability goes to lease_terms_notes, not available_from.",
  }),
  scenario({
    name: "multiple-listings",
    initialCRMState: {},
    messages: ["О какой квартире речь?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status", "update_rental_terms"],
    note: "Agent must clarify which listing is discussed before writing anything.",
  }),
  scenario({
    name: "agreed-phase-collection",
    initialCRMState: {
      crm_status: "agreed",
      rentalTerms: { price: 900, availability_status: "available", minimum_lease_months: 12, commission_type: "fixed" },
    },
    messages: ["Вид на море", "ЖК Batumi Towers"],
    expectedActions: [
      { type: "update_deal_info", data: { window_view: "море" } },
      { type: "update_deal_info", data: { complex_name: "Batumi Towers" } },
      { type: "set_crm_status", status: "qualified" },
    ],
    forbiddenActions: [],
    stopConversation: true,
    note: "Пачка отвечена целиком — закрытие тем же ходом: qualified, финальная сводка, stop.",
  }),
  scenario({
    name: "agreed-confirm-qualified",
    initialCRMState: {
      crm_status: "agreed",
      window_view: "море",
      complex_name: "Orbi City",
      rentalTerms: {
        price: 900,
        currency: "USD",
        transaction_type: "rent_long_term",
        price_period: "month",
        availability_status: "available",
        minimum_lease_months: 12,
        commission_type: "fixed",
      },
    },
    messages: ["Да, всё верно"],
    expectedActions: [{ type: "set_crm_status", status: "qualified" }],
    forbiddenActions: [],
    stopConversation: true,
    note: "Кадастровый номер и согласие на публикацию не требуются для qualified.",
  }),
  scenario({
    name: "agreed-confirm-incomplete",
    initialCRMState: {
      crm_status: "agreed",
      window_view: null,
      complex_name: "Orbi City",
      rentalTerms: {
        price: 900,
        currency: "USD",
        transaction_type: "rent_long_term",
        price_period: "month",
        availability_status: "available",
        minimum_lease_months: 12,
        commission_type: "fixed",
      },
    },
    messages: ["Да, всё верно"],
    expectedActions: [{ type: "set_crm_status", status: "qualified" }],
    forbiddenActions: ["set_crm_status:disagreed"],
    stopConversation: true,
    note: "Вид из окон не назван — это больше не блокирует: пробел в agent_notes и закрытие.",
  }),
  scenario({
    name: "agreed-partial-bundle-closes",
    initialCRMState: {
      crm_status: "agreed",
      window_view: null,
      complex_name: null,
      rentalTerms: {
        price: 900,
        currency: "USD",
        transaction_type: "rent_long_term",
        price_period: "month",
        availability_status: "available",
        minimum_lease_months: 12,
      },
    },
    priorHistory: [{ role: "assistant", content: "Какой вид из окон и в каком ЖК квартира?" }],
    messages: ["Вид во двор, про ЖК не знаю, больше ничего добавить не могу"],
    expectedActions: [
      { type: "update_deal_info", data: { window_view: "двор" } },
      { type: "set_crm_status", status: "qualified" },
    ],
    forbiddenActions: ["set_crm_status:disagreed"],
    stopConversation: true,
    note: "Частичный ответ на пачку: зафиксировать названное, недостающее — в agent_notes, закрыть одним ходом.",
  }),
  scenario({
    name: "agreed-nothing-more-to-add",
    initialCRMState: { crm_status: "agreed", window_view: "море", complex_name: "Orbi City" },
    messages: ["Больше ничего не знаю, всё есть в объявлении"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "Агент не выпрашивает кадастровый номер и согласие на публикацию: описания и CRM достаточно.",
  }),
  scenario({
    name: "agreed-description-covers-amenities",
    initialCRMState: {
      crm_status: "agreed",
      window_view: null,
      complex_name: null,
      rentalTerms: {
        price: 900,
        currency: "USD",
        transaction_type: "rent_long_term",
        price_period: "month",
        availability_status: "available",
        minimum_lease_months: 12,
        commission_type: "fixed",
      },
    },
    messages: ["Вид на море, ЖК Orbi City", "Да, всё верно"],
    expectedActions: [
      { type: "update_deal_info", data: { window_view: "море" } },
      { type: "update_deal_info", data: { complex_name: "Orbi City" } },
      { type: "set_crm_status", status: "qualified" },
    ],
    forbiddenActions: [],
    stopConversation: true,
    note: "Удобства из описания (балкон, бассейн, спортзал) не переспрашиваются; кадастр и согласие на публикацию не требуются.",
  }),
  scenario({
    name: "qualified-substantive-thanks",
    initialCRMState: { crm_status: "qualified" },
    messages: ["Спасибо большое!"],
    expectedActions: [],
    forbiddenActions: ["set_contact_type", "update_deal_info", "update_rental_terms", "set_crm_status"],
    noQuestionOk: true,
    note: "Qualified dialogs get plain answers, never CRM actions.",
  }),
  scenario({
    name: "qualified-substantive-question",
    initialCRMState: { crm_status: "qualified" },
    messages: ["А когда можно посмотреть квартиру?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status", "update_rental_terms"],
    noQuestionOk: true,
  }),
  scenario({
    name: "owner-asks-question",
    initialCRMState: {},
    messages: ["А сколько у вас арендаторов сейчас?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
  }),
  scenario({
    name: "user-corrects-crm-data",
    initialCRMState: { address: "Batumi, old street 1" },
    messages: ["Адрес неправильный, правильный Batumi, Kobaladze 12"],
    expectedActions: [{ type: "update_deal_info" }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
    note: "Corrections land in agent_notes / fixed fields, never ignored.",
  }),
  scenario({
    name: "several-messages-at-once",
    initialCRMState: {},
    messages: ["Да", "Я собственник", "Можно работать", "900 в месяц", "Вид на море"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "set_crm_status", status: "agreed" },
      { type: "update_deal_info", data: { window_view: "море" } },
    ],
    forbiddenActions: ["set_crm_status:disagreed"],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
  }),
  scenario({
    name: "mixed-language",
    initialCRMState: {},
    messages: ["Yes, I am the owner, the flat is for long-term rent"],
    expectedActions: [{ type: "set_contact_type", contactType: "owner" }],
    forbiddenActions: [],
  }),
  scenario({
    name: "georgian-owner",
    initialCRMState: {},
    messages: ["დიახ, მე ვარ მეპატრონე, ბინა ქირავდება"],
    expectedActions: [{ type: "set_contact_type", contactType: "owner" }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-min-lease",
    initialCRMState: {},
    messages: ["Минимальный срок 6 месяцев"],
    expectedActions: [{ type: "update_rental_terms", data: { minimum_lease_months: 6 } }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
  }),
  scenario({
    name: "owner-seasonal-prices",
    initialCRMState: {},
    messages: ["Зимой 1200, летом 1500"],
    expectedActions: [{ type: "update_rental_terms" }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount", "prepayment_months"],
    },
    note: "Seasonality belongs in lease_terms_notes as text.",
  }),
  scenario({
    name: "owner-prepayment",
    initialCRMState: {},
    messages: ["Предоплата 2 месяца"],
    expectedActions: [{ type: "update_rental_terms", data: { prepayment_months: 2 } }],
    forbiddenActions: [],
    forbiddenDataKeys: {
      update_rental_terms: ["commission_type", "commission_value", "commission_payer", "deposit_amount"],
    },
  }),
  scenario({
    name: "owner-refuses-then-softens",
    initialCRMState: {},
    messages: ["Нет, спасибо", "Хотя расскажите подробнее"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "Softening after refusal must not be terminal.",
  }),
  scenario({
    name: "live-regression-terse-consent",
    initialCRMState: {},
    messages: ["да", "1 god mojna.. 600$", "da maia", "daa"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_rental_terms", data: { price: 600, minimum_lease_months: 12 } },
      { type: "set_crm_status", status: "agreed" },
    ],
    forbiddenActions: ["set_crm_status:qualified", "set_crm_status:disagreed"],
    forbiddenDataKeys: {
      update_rental_terms: [
        "commission_type",
        "commission_value",
        "commission_payer",
        "commission_notes",
        "deposit_amount",
        "prepayment_months",
      ],
    },
    expectedFinalCRMState: {
      contact_type: "owner",
      crm_status: "agreed",
      rentalTerms: { price: 600, minimum_lease_months: 12 },
    },
    transitionReplies: [
      { fromStatus: "delivered", toStatus: "agreed", replyMustContain: ["вид из окон", "жк"] },
    ],
    note: "Живой regression transcript: ответом на «daa» должна уйти пачка фазы 2, а не «Принял», и без выдуманной комиссии.",
  }),
  scenario({
    name: "live-regression-exact-history",
    initialCRMState: {
      crm_status: "read",
      contact_type: "owner",
      rentalTerms: { price: 600, minimum_lease_months: 12 },
    },
    priorHistory: [
      { role: "assistant", content: "Квартиру ещё сдаёте?" },
      { role: "user", content: "da" },
      { role: "assistant", content: "Вы собственник? Какая цена, депозит, минимальный срок?" },
      { role: "user", content: "1 god mojna.. 600$" },
      { role: "user", content: "da maia" },
      { role: "assistant", content: "Готовы ли вы сотрудничать с агентством Batumi.key?" },
    ],
    messages: ["daa"],
    expectedActions: [{ type: "set_crm_status", status: "agreed" }],
    forbiddenActions: ["set_crm_status:qualified", "set_crm_status:disagreed"],
    forbiddenDataKeys: {
      update_rental_terms: [
        "commission_type",
        "commission_value",
        "commission_payer",
        "commission_notes",
        "deposit_amount",
        "prepayment_months",
      ],
    },
    expectedFinalCRMState: {
      contact_type: "owner",
      crm_status: "agreed",
      rentalTerms: { price: 600, minimum_lease_months: 12 },
    },
    transitionReplies: [
      { fromStatus: "read", toStatus: "agreed", replyMustContain: ["вид из окон", "жк"] },
    ],
    note: "Replays the live CRM snapshot and exact cooperation question before the final owner reply `daa`.",
  }),
  scenario({
    name: "adversarial-transliterated-no-availability",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [{ role: "assistant", content: "Квартира ещё сдаётся на длительный срок?" }],
    messages: ["ara, uzhe sdali"],
    expectedActions: [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
    forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed", "set_crm_status:qualified"],
    forbiddenDataKeys: { update_rental_terms: ["commission_type", "commission_payer"] },
    expectedTurns: [{
      crmStatusBefore: "delivered",
      crmStatusAfter: "delivered",
      requiredActions: [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
      expectedCRMState: { crm_status: "delivered", contact_type: "potential_owner", rentalTerms: { availability_status: "rented" } },
      forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed"],
    }],
    stopConversation: true,
    noQuestionOk: true,
    note: "Transliterated no is tied to the immediately preceding availability question; it cannot grant owner identity or cooperation.",
  }),
  scenario({
    name: "adversarial-ambiguous-yes-to-two-questions",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [{ role: "assistant", content: "Квартира ещё сдаётся и вы собственник?" }],
    messages: ["da"],
    expectedActions: [],
    forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed", "set_crm_status:qualified"],
    expectedTurns: [{
      crmStatusBefore: "delivered",
      crmStatusAfter: "delivered",
      expectedCRMState: { crm_status: "delivered", contact_type: "potential_owner" },
      replyMustContain: ["собственник"],
      forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed"],
    }],
    note: "A bare transliterated yes cannot answer two materially different questions or establish consent.",
  }),
  scenario({
    name: "adversarial-owner-corrects-terms",
    initialCRMState: { crm_status: "read", contact_type: "owner", rentalTerms: { price: 850, minimum_lease_months: 12 } },
    priorHistory: [{ role: "assistant", content: "Цена 850 долларов и минимальный срок 12 месяцев, верно?" }],
    messages: ["Нет, исправление: 950 в месяц, минимум 6 месяцев"],
    expectedActions: [
      { type: "update_rental_terms", data: { price: 950 } },
      { type: "update_rental_terms", data: { minimum_lease_months: 6 } },
    ],
    forbiddenActions: ["set_crm_status:disagreed", "set_crm_status:qualified"],
    forbiddenDataKeys: { update_rental_terms: ["commission_type", "commission_payer", "deposit_amount", "prepayment_months"] },
    expectedTurns: [{
      crmStatusBefore: "read",
      crmStatusAfter: "read",
      expectedCRMState: { crm_status: "read", contact_type: "owner", rentalTerms: { price: 950, minimum_lease_months: 6 } },
      replyMustContain: ["950", "6"],
      forbiddenActions: ["set_crm_status:disagreed", "set_crm_status:qualified"],
    }],
    note: "A correction replaces the old price and lease term; it does not imply refusal or unmentioned commission/deposit facts.",
  }),
  scenario({
    name: "adversarial-side-question-does-not-grant-consent",
    initialCRMState: { crm_status: "read", contact_type: "owner" },
    priorHistory: [{ role: "assistant", content: "Вы готовы сотрудничать с агентством?" }],
    messages: ["А сколько у вас сейчас клиентов?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:agreed", "set_crm_status:qualified", "set_crm_status:disagreed"],
    expectedTurns: [{
      crmStatusBefore: "read",
      crmStatusAfter: "read",
      expectedCRMState: { crm_status: "read", contact_type: "owner" },
      replyMustContain: ["клиент"],
      forbiddenActions: ["set_crm_status:agreed", "set_crm_status:qualified"],
    }],
    note: "Answer the owner's side question without treating it as an answer to the pending cooperation question.",
  }),
  scenario({
    name: "adversarial-irrelevant-reply-does-not-mutate-crm",
    initialCRMState: { crm_status: "read", contact_type: "owner", rentalTerms: { price: 900, minimum_lease_months: null } },
    priorHistory: [{ role: "assistant", content: "Какой минимальный срок аренды?" }],
    messages: ["Сегодня очень солнечно"],
    expectedActions: [],
    forbiddenActions: ["update_rental_terms", "set_crm_status:agreed", "set_crm_status:qualified"],
    expectedTurns: [{
      crmStatusBefore: "read",
      crmStatusAfter: "read",
      expectedCRMState: { crm_status: "read", contact_type: "owner", rentalTerms: { price: 900, minimum_lease_months: null } },
      replyMustContain: ["срок"],
      forbiddenActions: ["update_rental_terms", "set_crm_status:agreed"],
    }],
    note: "An irrelevant response cannot fill missing rental terms or change the CRM status.",
  }),
  scenario({
    name: "adversarial-owner-changes-mind",
    initialCRMState: { crm_status: "delivered" },
    messages: ["Да, я собственник и готов сотрудничать", "Нет, я передумал, сотрудничать не буду"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "set_crm_status", status: "agreed" },
      { type: "set_crm_status", status: "disagreed" },
    ],
    forbiddenActions: ["set_crm_status:qualified"],
    forbiddenDataKeys: { update_rental_terms: ["commission_type", "commission_payer"] },
    expectedTurns: [
      {
        crmStatusBefore: "delivered",
        crmStatusAfter: "agreed",
        requiredActions: [{ type: "set_crm_status", status: "agreed" }],
        expectedCRMState: { crm_status: "agreed", contact_type: "owner" },
        replyMustContain: ["вид из окон"],
      },
      {
        crmStatusBefore: "agreed",
        crmStatusAfter: "disagreed",
        requiredActions: [{ type: "set_crm_status", status: "disagreed" }],
        expectedCRMState: { crm_status: "disagreed", contact_type: "owner" },
      },
    ],
    stopConversation: true,
    note: "A clear later change of mind overrides prior cooperation consent; it must not qualify or invent terms.",
  }),
  scenario({
    name: "adversarial-unavailable-means-no-agreement",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [{ role: "assistant", content: "Квартира сейчас свободна для долгосрочной аренды?" }],
    messages: ["Нет, уже сдали"],
    expectedActions: [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
    forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed", "set_crm_status:qualified"],
    expectedTurns: [{
      crmStatusBefore: "delivered",
      crmStatusAfter: "delivered",
      requiredActions: [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
      expectedCRMState: { crm_status: "delivered", contact_type: "potential_owner", rentalTerms: { availability_status: "rented" } },
      forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed"],
    }],
    note: "Already rented is an availability fact, not cooperation consent or owner qualification.",
  }),
  scenario({
    name: "adversarial-realtor-after-apparent-yes",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [{ role: "assistant", content: "Квартира ещё сдаётся?" }],
    messages: ["Да", "Я агент, не собственник"],
    expectedActions: [{ type: "set_contact_type", contactType: "realtor" }],
    forbiddenActions: ["set_contact_type:owner", "set_crm_status:agreed", "set_crm_status:qualified"],
    expectedTurns: [
      {
        crmStatusBefore: "delivered",
        crmStatusAfter: "delivered",
        requiredActions: [{ type: "update_rental_terms", data: { availability_status: "available" } }],
        expectedCRMState: { crm_status: "delivered", contact_type: "potential_owner", rentalTerms: { availability_status: "available" } },
      },
      {
        crmStatusBefore: "delivered",
        crmStatusAfter: "delivered",
        requiredActions: [{ type: "set_contact_type", contactType: "realtor" }],
        expectedCRMState: { crm_status: "delivered", contact_type: "realtor" },
      },
    ],
    stopConversation: true,
    note: "Later explicit realtor disclosure overrides the provisional owner lead and terminates owner acquisition.",
  }),
  scenario({
    name: "adversarial-multiple-listings-clarify-before-write",
    initialCRMState: { crm_status: "read" },
    messages: ["Я сдаю две квартиры, про какую вы спрашиваете?"],
    expectedActions: [],
    forbiddenActions: ["update_rental_terms", "update_deal_info", "set_crm_status:agreed", "set_crm_status:qualified"],
    expectedTurns: [{
      crmStatusBefore: "read",
      crmStatusAfter: "read",
      expectedCRMState: { crm_status: "read" },
      replyMustContain: ["квартир"],
      forbiddenActions: ["update_rental_terms", "update_deal_info"],
    }],
    note: "This harness supplies one listing only, so the agent must clarify and make no listing-scoped writes.",
  }),
  scenario({
    name: "live-regression-owner-facts-without-cooperation-consent",
    initialCRMState: { crm_status: "delivered" },
    priorHistory: [
      { role: "assistant", content: "Здравствуйте! Объявление актуально?" },
      { role: "user", content: "Добрый день. Объявление актуально, но квартира сдаётся до сезона." },
      { role: "assistant", content: "Вы собственник этой квартиры? — Какая цена в месяц, депозит и минимальный срок?" },
    ],
    messages: [
      "Да, я собственник квартиры. Квартира сдаётся минимум на 2 месяца, максимум на 8 месяцев. Оплата производится заранее за 2 месяца. Квартира находится по адресу: ул. Шериф Химшиашвили, 27, на 4-м этаже. В квартире: 3 спальни • 2 ванные комнаты • 2 балкона • просторная гостиная • отдельная кухня. Все комнаты светлые. Стоимость аренды – 1500 долларов в месяц.",
    ],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_rental_terms", data: { price: 1500 } },
      { type: "update_rental_terms", data: { minimum_lease_months: 2 } },
      { type: "update_rental_terms", data: { prepayment_months: 2 } },
    ],
    forbiddenActions: ["set_crm_status:agreed", "set_crm_status:qualified", "set_crm_status:disagreed"],
    forbiddenDataKeys: { update_rental_terms: ["commission_type", "commission_payer", "deposit_amount"] },
    expectedTurns: [{
      crmStatusBefore: "delivered",
      crmStatusAfter: "delivered",
      requiredActions: [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_rental_terms", data: { price: 1500 } },
        { type: "update_rental_terms", data: { minimum_lease_months: 2 } },
        { type: "update_rental_terms", data: { prepayment_months: 2 } },
      ],
      expectedCRMState: {
        crm_status: "delivered",
        contact_type: "owner",
        rentalTerms: { price: 1500, minimum_lease_months: 2, prepayment_months: 2 },
      },
      replyMustContain: ["сотруднич"],
      forbiddenActions: ["set_crm_status:agreed", "set_crm_status:qualified"],
    }],
    note: "Long owner reply answers identity and terms only. Maximum lease is not forced into a dedicated field; no cooperation question was asked or consent given, so ask it and keep status unchanged.",
  }),
];

export function findScenario(name: string): ConversationScenario | undefined {
  return scenarios.find((s) => s.name === name);
}
