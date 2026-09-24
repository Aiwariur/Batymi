import { describe, expect, it } from "vitest";
import { finalizeAgentResponse } from "../../src/conversation/conversation.service";
import { Listing } from "../../src/types";
import { baseListing } from "../conversations/scenarios";

function guard(input: {
  reply: string;
  batchText: string;
  history?: Array<{ role: "assistant" | "user"; content: string }>;
  listing?: Listing;
}) {
  const listing = input.listing ?? structuredClone(baseListing);
  return finalizeAgentResponse({
    result: { reply: input.reply, actions: [], stopConversation: false },
    phase: "primary",
    history: input.history ?? [],
    batchText: input.batchText,
    listings: [listing],
    primaryListing: listing,
  });
}

describe("dialogue quality regressions from Batymi screenshots", () => {
  it("replaces a generic greeting with the reason for contact and an owner question", () => {
    const guarded = guard({
      reply: "Здравствуйте! Как могу помочь?",
      history: [{
        role: "assistant",
        content: "Здравствуйте! Пишу по вашему объявлению: квартира ещё сдаётся на длительный срок?",
      }],
      batchText: "Добрый день",
    });

    expect(guarded.reply).toMatch(/кобаладзе|объявлени|квартир/i);
    expect(guarded.reply).toMatch(/собственник|владелец/i);
    expect(guarded.reply).not.toMatch(/как могу помочь/i);
  });

  it("repairs a dangling 'a few questions' preamble with a concrete next question", () => {
    const guarded = guard({
      reply: "Отлично! Пару уточнений:",
      history: [{ role: "assistant", content: "Квартира ещё сдаётся на длительный срок?" }],
      batchText: "Да, активно",
    });

    expect(guarded.reply).toMatch(/[?？]/);
    expect(guarded.reply).toMatch(/собственник|владелец/i);
    expect(guarded.reply).not.toMatch(/пару уточнений:\s*$/i);
  });

  it("replaces a technical realtor explanation with a natural, final closing", () => {
    const guarded = guard({
      reply: "Понял, спасибо. Мы работаем только напрямую с собственниками, поэтому не буду продолжать автоматическое предложение по этому контакту.",
      batchText: "Да, я агент, сдаётся на год",
    });

    expect(guarded.gate.allowed).toContainEqual({ type: "set_contact_type", contactType: "realtor" });
    expect(guarded.stopConversation).toBe(true);
    expect(guarded.reply).not.toMatch(/автоматическ|по этому контакту/i);
    expect(guarded.reply).toMatch(/спасибо|благодар/i);
    expect(guarded.reply).not.toMatch(/[?？]/);
  });

  it("preserves a useful direct answer to the owner's apartment question", () => {
    const listing = structuredClone(baseListing);
    listing.contact_type = "owner";
    const guarded = guard({
      reply: "Речь о квартире по адресу Batumi, Kobaladze 12: 2 комнаты, 58 м², 900 USD в месяц. Вот объявление: https://example.com/flat/101",
      history: [{ role: "user", content: "Я собственник. Какая именно квартира вас интересует?" }],
      batchText: "Какая именно квартира вас интересует?",
      listing,
    });

    expect(guarded.reply).toMatch(/Kobaladze 12/);
    expect(guarded.reply).toMatch(/900 USD/);
    expect(guarded.reply).toMatch(/https:\/\/example\.com\/flat\/101/);
    expect(guarded.reply).not.toMatch(/вы собственник|готовы сотрудничать/i);
  });

  it("keeps a valid apartment-identification reply without adding an unrelated owner question", () => {
    const directAnswer = "Это квартира по адресу Batumi, Kobaladze 12, 2 комнаты, 58 м², 900 USD в месяц: https://example.com/flat/101";
    const listing = structuredClone(baseListing);
    listing.contact_type = "owner";
    const guarded = guard({
      reply: directAnswer,
      batchText: "О какой квартире речь?",
      listing,
    });

    expect(guarded.reply).toContain("Batumi, Kobaladze 12");
    expect(guarded.reply).toContain("900 USD в месяц");
    expect(guarded.reply).toContain("https://example.com/flat/101");
    expect(guarded.reply).not.toMatch(/вы собственник/i);
  });

  it("does not ask ownership again once the contact is known to be the owner", () => {
    const listing = structuredClone(baseListing);
    listing.contact_type = "owner";
    const guarded = guard({
      reply: "Понял, спасибо. Вы собственник этой квартиры?",
      history: [{ role: "assistant", content: "Вы собственник этой квартиры?" }],
      batchText: "Да, я собственник",
      listing,
    });

    expect(guarded.gate.allowed).not.toContainEqual({ type: "set_contact_type", contactType: "owner" });
    expect(guarded.reply).toMatch(/сотрудничать|работать с агентств/i);
    expect(guarded.reply).not.toMatch(/вы собственник|владелец этой квартиры/i);
  });

  it("does not interpret a bare yes as owner confirmation just because the opening mentions tenants", () => {
    const guarded = guard({
      reply: "Да, понял.",
      history: [{
        role: "assistant",
        content: "Здравствуйте! Мы подбираем арендаторов для квартир в Батуми. Ваша квартира ещё сдаётся на длительный срок?",
      }],
      batchText: "Да",
    });

    expect(guarded.gate.allowed).not.toContainEqual({ type: "set_contact_type", contactType: "owner" });
    expect(guarded.gate.allowed).toContainEqual({
      type: "update_rental_terms",
      listingId: baseListing.id,
      data: { availability_status: "available" },
    });
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply).toMatch(/собственник|владелец/i);
  });

  it("records 'Да, активно' as availability after a standalone availability question", () => {
    const guarded = guard({
      reply: "Понял, спасибо.",
      history: [{ role: "assistant", content: "Объявление актуально? Квартира ещё сдаётся на долгий срок?" }],
      batchText: "Да, активно",
    });

    expect(guarded.gate.allowed).toContainEqual({
      type: "update_rental_terms",
      listingId: baseListing.id,
      data: { availability_status: "available" },
    });
    expect(guarded.gate.allowed).not.toContainEqual({ type: "set_contact_type", contactType: "owner" });
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply).toMatch(/собственник|владелец/i);
  });

  it("uses the final direct owner question after a separate introduction to interpret a bare yes", () => {
    const guarded = guard({
      reply: "Понял, спасибо.",
      history: [{
        role: "assistant",
        content: "Здравствуйте! Мы помогаем собственникам находить арендаторов в Батуми. Вы собственник этой квартиры?",
      }],
      batchText: "Да",
    });

    expect(guarded.gate.allowed).toContainEqual({ type: "set_contact_type", contactType: "owner" });
    expect(guarded.gate.allowed.some((action) => action.type === "set_crm_status" && action.status === "agreed")).toBe(false);
    expect(guarded.reply).toMatch(/сотрудничать с агентств/i);
  });

  it.each(["Вы агент или собственник?", "Я не агент, я собственник"])(
    "does not classify a question or negated role as realtor: %s",
    (batchText) => {
      const guarded = guard({
        reply: "Понял, спасибо.",
        batchText,
      });

      expect(guarded.gate.allowed).not.toContainEqual({ type: "set_contact_type", contactType: "realtor" });
      expect(guarded.stopConversation).toBe(false);
      if (batchText.includes("не агент")) {
        expect(guarded.gate.allowed).toContainEqual({ type: "set_contact_type", contactType: "owner" });
      }
    },
  );

  it("preserves a substantive commission answer when the model incorrectly requests a stop", () => {
    const listing = structuredClone(baseListing);
    listing.contact_type = "owner";
    listing.crm_status = "agreed";
    listing.window_view = "море";
    listing.complex_name = "Orbi City";
    listing.rental_terms = {
      ...listing.rental_terms,
      availability_status: "available",
      minimum_lease_months: 12,
    };
    const guarded = finalizeAgentResponse({
      result: {
        reply: "Комиссия зависит от условий аренды. Точный размер сейчас не указан, я уточню это у менеджера.",
        actions: [],
        stopConversation: true,
      },
      phase: "agreed",
      history: [],
      batchText: "Какая комиссия у агентства?",
      listings: [listing],
      primaryListing: listing,
    });

    expect(guarded.reply).toMatch(/комисс|менеджер/i);
    expect(guarded.reply).not.toMatch(/вид из окон|какой жк/i);
    expect(guarded.stopConversation).toBe(false);
  });
});
