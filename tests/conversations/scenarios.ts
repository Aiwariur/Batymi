import { Listing, RentalTerms } from "../../src/types";

export interface ExpectedAction {
  type: "set_contact_type" | "update_deal_info" | "update_rental_terms" | "set_crm_status";
  contactType?: string;
  status?: string;
  data?: Record<string, unknown>;
}

export type ScenarioCRMState = Partial<Listing> & { rentalTerms?: Partial<RentalTerms> };

export interface ConversationScenario {
  name: string;
  initialCRMState: ScenarioCRMState;
  messages: string[];
  expectedActions: ExpectedAction[];
  forbiddenActions: string[];
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
    publication_consent: null,
  },
};

function scenario(input: ConversationScenario): ConversationScenario {
  return input;
}

export const scenarios: ConversationScenario[] = [
  scenario({
    name: "owner-simple",
    initialCRMState: {},
    messages: ["Да, квартира сдаётся", "Я собственник", "Готовы работать"],
    expectedActions: [{ type: "set_contact_type", contactType: "owner" }],
    forbiddenActions: ["set_crm_status:qualified"],
    note: "Primary phase must stop at agreed; qualified belongs to phase 2.",
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
    note: "All facts from one message must be extracted; qualification continues in phase 2.",
  }),
  scenario({
    name: "owner-short-answers",
    initialCRMState: {},
    messages: ["Да", "Собственник", "Можно", "900 в месяц", "Море", "Orbi"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_rental_terms" },
      { type: "update_deal_info" },
    ],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-changes-price",
    initialCRMState: { rentalTerms: { price: 850 } },
    messages: ["Цена теперь 950 в месяц"],
    expectedActions: [{ type: "update_rental_terms", data: { price: 950 } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-no-complex",
    initialCRMState: {},
    messages: ["Квартира без ЖК, обычный дом"],
    expectedActions: [{ type: "update_deal_info", data: { complex_name: "нет ЖК" } }],
    forbiddenActions: [],
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
    ],
    forbiddenActions: [],
    note: "Кадастровый номер и согласие на публикацию больше не собираются.",
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
    expectedActions: [],
    forbiddenActions: ["set_crm_status:qualified"],
    note: "Window view unknown — keep collecting instead of qualifying.",
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
    note: "Qualified dialogs get plain answers, never CRM actions.",
  }),
  scenario({
    name: "qualified-substantive-question",
    initialCRMState: { crm_status: "qualified" },
    messages: ["А когда можно посмотреть квартиру?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status", "update_rental_terms"],
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
  }),
  scenario({
    name: "owner-seasonal-prices",
    initialCRMState: {},
    messages: ["Зимой 1200, летом 1500"],
    expectedActions: [{ type: "update_rental_terms" }],
    forbiddenActions: [],
    note: "Seasonality belongs in lease_terms_notes as text.",
  }),
  scenario({
    name: "owner-prepayment",
    initialCRMState: {},
    messages: ["Предоплата 2 месяца"],
    expectedActions: [{ type: "update_rental_terms", data: { prepayment_months: 2 } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-refuses-then-softens",
    initialCRMState: {},
    messages: ["Нет, спасибо", "Хотя расскажите подробнее"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "Softening after refusal must not be terminal.",
  }),
];

export function findScenario(name: string): ConversationScenario | undefined {
  return scenarios.find((s) => s.name === name);
}
