import { describe, expect, it } from "vitest";
import { finalizeAgentResponse } from "../../src/conversation/conversation.service";
import { resolvePhase } from "../../src/agent/system-prompt";
import { baseListing } from "../conversations/scenarios";

describe("production conversation response guard", () => {
  it("does not advance a multi-listing contact without the owner's listing choice", () => {
    const first = structuredClone(baseListing);
    const second = { ...structuredClone(baseListing), id: 202 };
    const guarded = finalizeAgentResponse({
      result: { reply: "Принял!", actions: [{ type: "set_crm_status", status: "agreed", listingId: first.id }], stopConversation: false },
      phase: "primary",
      history: [{ role: "assistant", content: "Готовы сотрудничать с агентством?" }],
      batchText: "Да, я собственник, готов сотрудничать",
      listings: [first, second],
      primaryListing: first,
    });
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status")).toBe(false);
    expect(guarded.reply).toMatch(/ID объявления/);
  });
  it("treats da after the availability question as neither owner confirmation nor cooperation consent", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Записал",
        actions: [
          { type: "set_contact_type", contactType: "owner" },
          { type: "set_crm_status", status: "agreed" },
        ],
        stopConversation: true,
      },
      phase: resolvePhase(listing.crm_status),
      history: [{ role: "assistant", content: "Квартира сейчас доступна для долгосрочной аренды?" }],
      batchText: "da",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.stopConversation).toBe(false);
    expect(guarded.reply).toContain("?");
    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(false);
    expect(guarded.reply.toLowerCase()).toContain("собственник");
  });

  it("treats transliterated yes as consent only after an explicit cooperation question and starts phase 2", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Принял",
        actions: [{ type: "set_crm_status", status: "agreed" }],
        stopConversation: true,
      },
      phase: "primary",
      history: [
        { role: "user", content: "Я собственник квартиры" },
        { role: "assistant", content: "Готовы ли вы сотрудничать с агентством Batumi.key?" },
      ],
      batchText: "daa",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(true);
    expect(guarded.stopConversation).toBe(false);
    expect(guarded.reply).toMatch(/вид из окон/i);
    expect(guarded.reply).toMatch(/жк/i);
    expect(guarded.reply).toContain("?");
  });

  it("does not treat an owner confirmation as cooperation consent after a combined question", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Спасибо",
        actions: [{ type: "set_contact_type", contactType: "owner" }, { type: "set_crm_status", status: "agreed" }],
        stopConversation: true,
      },
      phase: "primary",
      history: [{ role: "assistant", content: "Вы собственник квартиры и готовы сотрудничать с агентством?" }],
      batchText: "Yes, I am the owner",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.reply.toLowerCase()).toContain("work with");
  });

  it("does not interpret a bare yes to a combined owner and cooperation question", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Thanks, noted.",
        actions: [{ type: "set_contact_type", contactType: "owner" }, { type: "set_crm_status", status: "agreed" }],
        stopConversation: true,
      },
      phase: "primary",
      history: [{ role: "assistant", content: "Are you the owner and are you ready to work with our agency?" }],
      batchText: "da",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply.toLowerCase()).toContain("собственник");
    expect(guarded.reply).not.toMatch(/work with/i);
    expect(guarded.stopConversation).toBe(false);
  });

  it.each(["Да, собственник", "собственник", "мой объект"])("confirms explicit owner wording: %s", (batchText) => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо.", actions: [], stopConversation: false },
      phase: "primary",
      history: [],
      batchText,
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply).toMatch(/сотрудничать с агентством/i);
  });

  it("confirms a bare yes only after an owner-only question", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Да.", actions: [], stopConversation: false },
      phase: "primary",
      history: [{ role: "assistant", content: "Вы собственник этой квартиры?" }],
      batchText: "Да",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
  });

  it.each(["Я агент", "Я риелтор", "Не собственник"])("classifies explicit non-owner contact as realtor: %s", (batchText) => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Понял, спасибо. Мы работаем только напрямую с собственниками.",
        actions: [{ type: "set_contact_type", contactType: "owner" }, { type: "set_crm_status", status: "agreed" }],
        stopConversation: false,
      },
      phase: "primary",
      history: [],
      batchText,
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "realtor")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.stopConversation).toBe(true);
    expect(guarded.reply).not.toContain("?");
  });

  it("turns clear cooperation consent into agreed when owner status is already known", () => {
    const listing = structuredClone(baseListing);
    listing.contact_type = "owner";
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо.", actions: [], stopConversation: false },
      phase: "primary",
      history: [{ role: "assistant", content: "Готовы сотрудничать с агентством?" }],
      batchText: "Да, готов сотрудничать",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(true);
    expect(guarded.reply).toMatch(/вид из окон/i);
    expect(guarded.reply).toMatch(/жк/i);
  });

  it("does not agree on long owner facts without cooperation consent", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо, записал.", actions: [{ type: "set_crm_status", status: "agreed" }], stopConversation: true },
      phase: "primary",
      history: [],
      batchText: "Я собственник квартиры. Цена 900 долларов, депозит 900, минимум 12 месяцев. Вид на море, ЖК Orbi City.",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply).toMatch(/сотрудничать с агентством/i);
  });

  it("does not agree when owner and cooperation were asked in one ambiguous question", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо.", actions: [{ type: "set_contact_type", contactType: "owner" }, { type: "set_crm_status", status: "agreed" }], stopConversation: true },
      phase: "primary",
      history: [{ role: "assistant", content: "Вы собственник квартиры и готовы сотрудничать с агентством?" }],
      batchText: "Да",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
  });

  it("keeps an ambiguous change of mind nonterminal but stops on a definitive one", () => {
    const listing = structuredClone(baseListing);
    listing.crm_status = "agreed";
    const ambiguous = finalizeAgentResponse({
      result: { reply: "Понял.", actions: [{ type: "set_crm_status", status: "disagreed" }], stopConversation: true },
      phase: "agreed",
      history: [],
      batchText: "Пока не уверен, возможно позже",
      listings: [listing],
      primaryListing: listing,
    });
    const definitive = finalizeAgentResponse({
      result: { reply: "Понял.", actions: [{ type: "set_crm_status", status: "disagreed" }], stopConversation: false },
      phase: "agreed",
      history: [],
      batchText: "Нет, я передумал, сотрудничать не буду",
      listings: [listing],
      primaryListing: listing,
    });

    expect(ambiguous.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "disagreed")).toBe(false);
    expect(ambiguous.stopConversation).toBe(false);
    expect(definitive.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "disagreed")).toBe(true);
    expect(definitive.stopConversation).toBe(true);
  });

  it("stops after explicit unavailability without asking owner or cooperation questions", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Понял, спасибо. Если ситуация изменится — напишите.", actions: [], stopConversation: false },
      phase: "primary",
      history: [{ role: "assistant", content: "Квартира сейчас свободна для долгосрочной аренды?" }],
      batchText: "Нет, уже сдали",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.reply).not.toContain("?");
    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.stopConversation).toBe(true);
  });

  it("preserves accepted qualified and disagreed terminal transitions through agreed-phase repair", () => {
    const listing = structuredClone(baseListing);
    listing.crm_status = "agreed";
    listing.window_view = "море";
    listing.complex_name = "Orbi City";
    listing.rental_terms = {
      ...listing.rental_terms,
      minimum_lease_months: 12,
      availability_status: "available",
    };
    const qualified = finalizeAgentResponse({
      result: { reply: "Готово.", actions: [{ type: "set_crm_status", status: "qualified" }], stopConversation: true },
      phase: "agreed",
      history: [{ role: "assistant", content: "Какой вид из окон? В каком ЖК квартира?" }],
      batchText: "Всё верно",
      listings: [listing],
      primaryListing: listing,
    });
    const refused = finalizeAgentResponse({
      result: { reply: "Спасибо.", actions: [{ type: "set_crm_status", status: "disagreed" }], stopConversation: true },
      phase: "agreed",
      history: [],
      batchText: "Не хочу больше сотрудничать, пожалуйста, не пишите",
      listings: [listing],
      primaryListing: listing,
    });

    expect(qualified.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "qualified")).toBe(true);
    expect(qualified.stopConversation).toBe(true);
    expect(refused.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "disagreed")).toBe(true);
    expect(refused.stopConversation).toBe(true);
  });

  it("accepts an owner who explicitly volunteers both ownership and cooperation", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Thank you.", actions: [], stopConversation: false },
      phase: "primary",
      history: [],
      batchText: "I am the owner and I am ready to work with your agency",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(true);
    expect(guarded.reply).toMatch(/view from the windows/i);
    expect(guarded.reply).toMatch(/residential complex/i);
  });

  it("records an owner's rental details but asks for cooperation before changing phase", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Принял!",
        actions: [
          { type: "set_contact_type", contactType: "owner" },
          { type: "set_crm_status", status: "agreed" },
          { type: "update_rental_terms", data: { availability_status: "available", price: 1500, minimum_lease_months: 2 } },
        ],
        stopConversation: true,
      },
      phase: "primary",
      history: [{ role: "assistant", content: "Вы собственник квартиры? Какая цена и условия аренды?" }],
      batchText: "Да, я собственник квартиры. Квартира сдаётся минимум на 2 месяца, максимум на 8 месяцев. Оплата производится заранее за 2 месяца. Стоимость аренды — 1500 долларов в месяц.",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_contact_type" && action.contactType === "owner")).toBe(true);
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.gate.allowed.some((action) => action.type === "update_rental_terms" && action.data.price === 1500)).toBe(true);
    expect(guarded.reply).toContain("сотрудничать с агентством");
    expect(guarded.reply).not.toContain("Принял");
    expect(guarded.stopConversation).toBe(false);
  });

  it("recovers the agreed transition when output parsing discarded all model actions", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: { reply: "Извините, я не уверен, что правильно понял. Уточните ваш ответ?", actions: [], stopConversation: false },
      phase: "primary",
      history: [
        { role: "user", content: "Я собственник" },
        { role: "assistant", content: "Готовы сотрудничать с агентством?" },
      ],
      batchText: "daa",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(true);
    expect(guarded.reply).toMatch(/вид из окон/i);
    expect(guarded.reply).toMatch(/жк/i);
    expect(guarded.reply.trim().endsWith("?")).toBe(true);
  });

  it("reopens the exchange when qualified is rejected for incomplete rental terms", () => {
    const listing = structuredClone(baseListing);
    listing.crm_status = "agreed";
    listing.rental_terms = { ...listing.rental_terms, minimum_lease_months: null };
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Спасибо, всё готово.",
        actions: [{ type: "set_crm_status", status: "qualified" }],
        stopConversation: true,
      },
      phase: "agreed",
      history: [{ role: "assistant", content: "Какой вид из окон? В каком ЖК квартира?" }],
      batchText: "да, всё верно",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "qualified")).toBe(false);
    expect(guarded.stopConversation).toBe(false);
    expect(guarded.reply).toContain("?");
    expect(guarded.reply.toLowerCase()).toContain("минимальный срок");
  });

  it("asks an unanswered mandatory rental field again even when it was asked before", () => {
    const listing = structuredClone(baseListing);
    listing.crm_status = "agreed";
    listing.rental_terms = { ...listing.rental_terms, minimum_lease_months: null };
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо, записал.", actions: [], stopConversation: false },
      phase: "agreed",
      history: [
        { role: "assistant", content: "Какой минимальный срок аренды?" },
        { role: "assistant", content: "Какой вид из окон и в каком ЖК квартира?" },
      ],
      batchText: "Хорошо",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.reply.toLowerCase()).toContain("минимальный срок");
  });

  it("does not qualify on an unrelated reply after optional phase-2 questions", () => {
    const listing = structuredClone(baseListing);
    listing.crm_status = "agreed";
    listing.rental_terms = {
      ...listing.rental_terms,
      price: 900,
      currency: "USD",
      price_period: "month",
      transaction_type: "rent_long_term",
      availability_status: "available",
      minimum_lease_months: 12,
    };
    const guarded = finalizeAgentResponse({
      result: { reply: "Спасибо.", actions: [{ type: "set_crm_status", status: "qualified" }], stopConversation: true },
      phase: "agreed",
      history: [{ role: "assistant", content: "Какой вид из окон? В каком ЖК находится квартира?" }],
      batchText: "Я перезвоню позже",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "qualified")).toBe(false);
    expect(guarded.stopConversation).toBe(false);
  });

  it("requires owner evidence before accepting available status", () => {
    const listing = structuredClone(baseListing);
    const makeResponse = (batchText: string, history: { role: "assistant" | "user"; content: string }[] = []) => finalizeAgentResponse({
      result: { reply: "Записал", actions: [{ type: "update_rental_terms", data: { availability_status: "available" } }], stopConversation: false },
      phase: "primary",
      history,
      batchText,
      listings: [listing],
      primaryListing: listing,
    });

    expect(makeResponse("Да").gate.allowed.some((action) => action.type === "update_rental_terms" && action.data.availability_status === "available")).toBe(false);
    expect(makeResponse("Квартира свободна, сдаётся сейчас").gate.allowed.some((action) => action.type === "update_rental_terms" && action.data.availability_status === "available")).toBe(true);
    expect(makeResponse("Да", [{ role: "assistant", content: "Квартира сейчас доступна для долгосрочной аренды?" }]).gate.allowed.some((action) => action.type === "update_rental_terms" && action.data.availability_status === "available")).toBe(true);
  });

  it("strips commission fields that the owner never discussed", () => {
    const listing = structuredClone(baseListing);
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Записал, спасибо.",
        actions: [{
          type: "update_rental_terms",
          data: { price: 950, commission_type: "fixed", commission_payer: "owner" },
        }],
        stopConversation: false,
      },
      phase: "primary",
      history: [],
      batchText: "Цена теперь 950 долларов в месяц",
      listings: [listing],
      primaryListing: listing,
    });

    const rentalUpdate = guarded.gate.allowed.find((action) => action.type === "update_rental_terms");
    expect(rentalUpdate?.type === "update_rental_terms" && rentalUpdate.data).toEqual({ price: 950 });
  });

  it("does not turn a rent amount into a deposit and records a stated one-year lease", () => {
    const listing = structuredClone(baseListing);
    const first = finalizeAgentResponse({
      result: {
        reply: "Записал",
        actions: [{ type: "update_rental_terms", data: { price: 600, deposit_amount: 600 } }],
        stopConversation: false,
      },
      phase: "primary",
      history: [],
      batchText: "Цена аренды 600 долларов в месяц",
      listings: [listing],
      primaryListing: listing,
    });
    const firstTerms = first.gate.allowed.find((action) => action.type === "update_rental_terms");
    expect(firstTerms?.type === "update_rental_terms" && firstTerms.data).toEqual({ price: 600 });

    const second = finalizeAgentResponse({
      result: {
        reply: "Принял",
        actions: [{ type: "update_rental_terms", data: { minimum_lease_months: 12 } }],
        stopConversation: false,
      },
      phase: "primary",
      history: [{ role: "assistant", content: "Какой минимальный срок аренды?" }],
      batchText: "1 god",
      listings: [listing],
      primaryListing: listing,
    });
    const secondTerms = second.gate.allowed.find((action) => action.type === "update_rental_terms");
    expect(secondTerms?.type === "update_rental_terms" && secondTerms.data).toEqual({ minimum_lease_months: 12 });
  });
});
