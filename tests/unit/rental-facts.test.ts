import { describe, expect, it } from "vitest";
import { AgentAction } from "../../src/agent/schemas";
import { groundRentalFacts } from "../../src/conversation/rental-facts";

const run = (currentMessage: string, proposedActions: AgentAction[] = [], extra: Partial<Parameters<typeof groundRentalFacts>[0]> = {}) =>
  groundRentalFacts({ currentMessage, proposedActions, ...extra });

describe("groundRentalFacts", () => {
  it("extracts minimum lease duration from ordinary Russian phrasing", () => {
    expect(run("Минимальный срок 6 месяцев")).toContainEqual({
      type: "update_rental_terms", data: { minimum_lease_months: 6 },
    });
    expect(run("1 god mojna..", [], { history: [] })).toContainEqual({
      type: "update_rental_terms", data: { minimum_lease_months: 12 },
    });
  });

  it("extracts a monthly price when the model omits it", () => {
    expect(run("900 в месяц")).toContainEqual({ type: "update_rental_terms", data: { price: 900 } });
    expect(run("1 god mojna.. 600$")).toContainEqual({
      type: "update_rental_terms", data: { price: 600, minimum_lease_months: 12 },
    });
  });

  it("extracts prepaid months from advance-payment wording", () => {
    expect(run("оплата заранее за 2 месяца")).toContainEqual({
      type: "update_rental_terms", data: { prepayment_months: 2 },
    });
    expect(run("Предоплата 2 месяца")).toContainEqual({
      type: "update_rental_terms", data: { prepayment_months: 2 },
    });
  });

  it("stores seasonal prices as notes and drops a guessed single rent price", () => {
    const result = run("Зимой 1200, летом 1500", [{
      type: "update_rental_terms", data: { price: 1500, currency: "USD" },
    }]);
    expect(result).toContainEqual({ type: "update_rental_terms", data: { lease_terms_notes: "Зимой 1200, летом 1500" } });
    expect(result.some((action) => action.type === "update_rental_terms" && (action.data.price !== undefined || action.data.currency !== undefined))).toBe(false);
  });

  it("records rented status from explicit negation without treating it as availability", () => {
    expect(run("Нет, уже сдали", [], { lastAssistantQuestion: "Квартира сейчас свободна?" })).toContainEqual({
      type: "update_rental_terms", data: { availability_status: "rented" },
    });
    expect(run("ara, uzhe sdali")).toContainEqual({
      type: "update_rental_terms", data: { availability_status: "rented" },
    });
  });

  it("permits available only when stated or as a terse answer to a direct availability question", () => {
    expect(run("да", [{ type: "update_rental_terms", data: { availability_status: "available" } }], {
      lastAssistantQuestion: "Квартира доступна для аренды?",
    })).toContainEqual({ type: "update_rental_terms", data: { availability_status: "available" } });
    expect(run("да", [{ type: "update_rental_terms", data: { availability_status: "available" } }], {
      lastAssistantQuestion: "Вы собственник?",
    })).toEqual([]);
  });

  it("only records commission payer and type when both are explicit", () => {
    expect(run("Комиссия 50% с первого месяца, платит собственник")).toContainEqual({
      type: "update_rental_terms",
      data: { commission_type: "percent_month", commission_value: "50", commission_payer: "owner" },
    });
    expect(run("Комиссия обсуждается", [{
      type: "update_rental_terms", data: { commission_type: "percent_month", commission_value: "50", commission_payer: "owner" },
    }])).toEqual([]);
  });

  it("extracts explicit no-complex and sea-view facts with the supplied listing id", () => {
    expect(run("Квартира без ЖК, вид на море", [], { primaryListingId: 77 })).toContainEqual({
      type: "update_deal_info", listingId: 77, data: { complex_name: "нет ЖК", window_view: "море" },
    });
  });

  it("understands terse answers to view and complex questions", () => {
    const question = "Какой вид из окон и в каком ЖК квартира?";
    expect(run("Море", [], { lastAssistantQuestion: question })).toContainEqual({
      type: "update_deal_info", data: { window_view: "море" },
    });
    expect(run("Orbi", [], { lastAssistantQuestion: question })).toContainEqual({
      type: "update_deal_info", data: { complex_name: "Orbi" },
    });
  });

  it("uses the preceding lease question to ground terse numeric answers", () => {
    expect(run("2", [{ type: "update_rental_terms", data: { minimum_lease_months: 2 } }], {
      lastAssistantQuestion: "Какой минимальный срок аренды в месяцах?",
    })).toContainEqual({ type: "update_rental_terms", data: { minimum_lease_months: 2 } });
    expect(run("600", [{ type: "update_rental_terms", data: { price: 600, commission_payer: "owner" } }], {
      lastAssistantQuestion: "Какая цена?",
    })).toContainEqual({ type: "update_rental_terms", data: { price: 600 } });
  });

  it("uses the current correction instead of an older lease value", () => {
    const result = run("Нет, теперь минимум 6 месяцев", [], {
      history: [{ role: "user", content: "Раньше минимум 12 месяцев" }],
    });
    expect(result).toContainEqual({ type: "update_rental_terms", data: { minimum_lease_months: 6 } });
    expect(result.some((action) => action.type === "update_rental_terms" && action.data.minimum_lease_months === 12)).toBe(false);
  });
});
