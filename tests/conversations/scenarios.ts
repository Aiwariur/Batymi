import { Flat } from "../../src/types";

export interface ExpectedAction {
  type: "set_contact_type" | "update_deal_info" | "set_crm_status";
  contactType?: string;
  status?: string;
  data?: Record<string, string>;
}

export interface ConversationScenario {
  name: string;
  initialCRMState: Partial<Flat>;
  messages: string[];
  expectedActions: ExpectedAction[];
  forbiddenActions: string[];
  expectedFinalCRMState?: Partial<Flat>;
  stopConversation?: boolean;
  note?: string;
}

export const baseFlat: Flat = {
  id: 101,
  crm_status: "delivered",
  phone: "+995555000001",
  contact_name: "Owner",
  contact_type: "potential_owner",
  address: "Batumi, Kobaladze 12",
  district: "New Boulevard",
  rooms: "2",
  area: "58",
  floor: "12",
  price: "95000",
  currency: "USD",
  url: "https://example.com/flat/101",
  commission_type: null,
  commission_value: null,
  price_net: null,
  window_view: null,
  complex_name: null,
  cadastral_code: null,
  agent_notes: null,
  assigned_manager_id: 2,
};

function scenario(input: ConversationScenario): ConversationScenario {
  return input;
}

export const scenarios: ConversationScenario[] = [
  scenario({
    name: "owner-simple",
    initialCRMState: {},
    messages: ["Да, квартира продаётся", "Я собственник", "Готовы работать"],
    expectedActions: [{ type: "set_contact_type", contactType: "owner" }],
    forbiddenActions: ["set_crm_status:qualified"],
    note: "Should not set qualified before commission/view/complex/cadastral.",
  }),
  scenario({
    name: "realtor",
    initialCRMState: {},
    messages: ["Я не собственник, я агент"],
    expectedActions: [{ type: "set_contact_type", contactType: "realtor" }],
    forbiddenActions: ["set_crm_status:qualified", "update_deal_info"],
    stopConversation: true,
  }),
  scenario({
    name: "realtor-late-disclosure",
    initialCRMState: {},
    messages: ["Да, продаётся", "Вообще я риелтор этой квартиры"],
    expectedActions: [{ type: "set_contact_type", contactType: "realtor" }],
    forbiddenActions: ["set_crm_status:qualified"],
    stopConversation: true,
  }),
  scenario({
    name: "owner-gives-everything-at-once",
    initialCRMState: {},
    messages: [
      "Да, я собственник, можно работать. Хочу 85 тысяч на руки, ваши сверху. Вид море, ЖК Orbi, кадастр 05.17.01.123",
    ],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_deal_info", data: { commission_type: "on_top", window_view: "море" } },
    ],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "All facts from one message should be extracted.",
  }),
  scenario({
    name: "owner-short-answers",
    initialCRMState: {},
    messages: ["Да", "Собственник", "Можно", "Море", "Orbi", "05.17.01.999"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_deal_info" },
    ],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-changes-price",
    initialCRMState: { price_net: "80000" },
    messages: ["Цена изменилась, хочу 90 тысяч на руки"],
    expectedActions: [{ type: "update_deal_info", data: { price_net: "90000" } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-no-complex",
    initialCRMState: {},
    messages: ["Квартира без ЖК, обычный дом"],
    expectedActions: [{ type: "update_deal_info", data: { complex_name: "-" } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-gives-commission-percent",
    initialCRMState: {},
    messages: ["Комиссия 3%, включена в цену"],
    expectedActions: [{ type: "update_deal_info", data: { commission_type: "percent" } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-wants-net-price",
    initialCRMState: {},
    messages: ["Хочу 85000 на руки, комиссию добавляйте сверху"],
    expectedActions: [{ type: "update_deal_info", data: { commission_type: "on_top", price_net: "85000" } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-refuses",
    initialCRMState: {},
    messages: ["Нет, продавать не буду, не интересно"],
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
    name: "bad-address",
    initialCRMState: { address: "12345" },
    messages: ["Да, всё верно, можно работать"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:qualified"],
    note: "Suspicious address must be clarified before qualified.",
  }),
  scenario({
    name: "multiple-flats",
    initialCRMState: {},
    messages: ["О какой квартире речь?"],
    expectedActions: [],
    forbiddenActions: [],
    note: "Agent should clarify which flat is discussed.",
  }),
  scenario({
    name: "already-known-fields",
    initialCRMState: { commission_type: "on_top", window_view: "море", complex_name: "Orbi", cadastral_code: "05.17.01.1" },
    messages: ["Да, данные верные"],
    expectedActions: [{ type: "set_crm_status", status: "qualified" }],
    forbiddenActions: [],
  }),
  scenario({
    name: "user-corrects-crm-data",
    initialCRMState: { address: "Batumi, old street 1" },
    messages: ["Адрес неправильный, правильный Batumi, Kobaladze 12"],
    expectedActions: [{ type: "update_deal_info" }],
    forbiddenActions: [],
  }),
  scenario({
    name: "several-messages-at-once",
    initialCRMState: {},
    messages: ["Да", "Я собственник", "Можно работать", "Хочу 85 тысяч на руки", "Вид на море"],
    expectedActions: [
      { type: "set_contact_type", contactType: "owner" },
      { type: "update_deal_info", data: { window_view: "море" } },
    ],
    forbiddenActions: ["set_crm_status:disagreed"],
  }),
  scenario({
    name: "confirmation",
    initialCRMState: { commission_type: "on_top", window_view: "море", complex_name: "Orbi", cadastral_code: "05.17.01.1" },
    messages: ["Да, всё правильно"],
    expectedActions: [{ type: "set_crm_status", status: "qualified" }],
    forbiddenActions: [],
    stopConversation: true,
  }),
  scenario({
    name: "owner-only-view-missing",
    initialCRMState: { commission_type: "on_top", complex_name: "Orbi", cadastral_code: "05.17.01.1" },
    messages: ["Вид на горы"],
    expectedActions: [{ type: "update_deal_info", data: { window_view: "горы" } }],
    forbiddenActions: ["set_crm_status:qualified"],
  }),
  scenario({
    name: "owner-only-cadastral-missing",
    initialCRMState: { commission_type: "on_top", window_view: "море", complex_name: "Orbi" },
    messages: ["Кадастровый номер 05.17.01.777"],
    expectedActions: [{ type: "update_deal_info", data: { cadastral_code: "05.17.01.777" } }],
    forbiddenActions: ["set_crm_status:qualified"],
  }),
  scenario({
    name: "owner-qualified-already",
    initialCRMState: { crm_status: "qualified" },
    messages: ["Есть ли покупатели?"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:qualified", "set_contact_type:owner"],
    note: "Terminal conversation must not restart qualification.",
  }),
  scenario({
    name: "owner-disagreed-already",
    initialCRMState: { crm_status: "disagreed" },
    messages: ["Передумал"],
    expectedActions: [],
    forbiddenActions: ["set_contact_type:owner"],
    note: "Terminal conversation must not restart qualification automatically.",
  }),
  scenario({
    name: "realtor-already",
    initialCRMState: { contact_type: "realtor" },
    messages: ["Есть покупатель"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:qualified"],
    note: "Realtor conversations stop qualification.",
  }),
  scenario({
    name: "mixed-language",
    initialCRMState: {},
    messages: ["Yes, it is my apartment, I am the owner"],
    expectedActions: [{ type: "set_contact_type", contactType: "owner" }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-asks-question",
    initialCRMState: {},
    messages: ["А сколько у вас покупателей сейчас?"],
    expectedActions: [],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-provides-notes",
    initialCRMState: {},
    messages: ["Продаю срочно, есть небольшой торг"],
    expectedActions: [],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-commission-in-price",
    initialCRMState: {},
    messages: ["Комиссия уже в цене"],
    expectedActions: [{ type: "update_deal_info", data: { commission_type: "in_price" } }],
    forbiddenActions: [],
  }),
  scenario({
    name: "owner-confirms-after-collecting",
    initialCRMState: { commission_type: "on_top", window_view: "море", complex_name: "-", cadastral_code: "05.17.01.2" },
    messages: ["Да, без ЖК, всё верно"],
    expectedActions: [{ type: "set_crm_status", status: "qualified" }],
    forbiddenActions: [],
    stopConversation: true,
  }),
  scenario({
    name: "owner-refuses-then-softens",
    initialCRMState: {},
    messages: ["Нет, спасибо", "Хотя расскажите подробнее"],
    expectedActions: [],
    forbiddenActions: ["set_crm_status:disagreed"],
    note: "Softening after refusal should not be terminal.",
  }),
];

export function findScenario(name: string): ConversationScenario | undefined {
  return scenarios.find((s) => s.name === name);
}
