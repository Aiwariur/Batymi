import { describe, expect, it } from "vitest";
import { scenarios } from "./scenarios";
import { actionMatches, buildListing, evaluate, forbiddenHit } from "./evaluate";
import { AgentAction } from "../../src/agent/schemas";

const REQUIRED_SCENARIOS = [
  "owner-simple",
  "realtor",
  "owner-gives-everything-at-once",
  "owner-short-answers",
  "owner-changes-price",
  "owner-no-complex",
  "owner-gives-commission-percent",
  "owner-refuses",
  "owner-soft-objection",
  "multiple-listings",
  "agreed-phase-collection",
  "agreed-confirm-qualified",
  "agreed-confirm-incomplete",
  "qualified-substantive-thanks",
  "several-messages-at-once",
  "live-regression-exact-history",
  "adversarial-transliterated-no-availability",
  "adversarial-ambiguous-yes-to-two-questions",
  "adversarial-owner-corrects-terms",
  "adversarial-side-question-does-not-grant-consent",
  "adversarial-irrelevant-reply-does-not-mutate-crm",
  "adversarial-owner-changes-mind",
  "adversarial-unavailable-means-no-agreement",
  "adversarial-realtor-after-apparent-yes",
  "adversarial-multiple-listings-clarify-before-write",
  "live-regression-owner-facts-without-cooperation-consent",
];

describe("conversation scenario suite", () => {
  it("has at least 35 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(35);
  });

  it("has unique names and required scenarios", () => {
    const names = scenarios.map((s) => s.name);
    expect(new Set(names).size).toBe(names.length);
    for (const required of REQUIRED_SCENARIOS) {
      expect(names).toContain(required);
    }
  });

  it("has well formed scenarios", () => {
    for (const scenario of scenarios) {
      expect(scenario.messages.length).toBeGreaterThan(0);
      for (const message of scenario.messages) expect(message.trim().length).toBeGreaterThan(0);
      if (scenario.expectedTurns) expect(scenario.expectedTurns.length).toBe(scenario.messages.length);
      for (const forbidden of scenario.forbiddenActions) {
        expect(forbidden).toMatch(
          /^(set_contact_type|set_crm_status|update_deal_info|update_rental_terms)(:.*)?$/,
        );
      }
    }
  });
});

describe("conversation evaluator", () => {
  const owner: AgentAction = { type: "set_contact_type", contactType: "owner" };
  const qualified: AgentAction = { type: "set_crm_status", status: "qualified" };

  it("matches expected actions", () => {
    expect(actionMatches(owner, { type: "set_contact_type", contactType: "owner" })).toBe(true);
    expect(actionMatches(owner, { type: "set_contact_type", contactType: "realtor" })).toBe(false);
  });

  it("detects forbidden actions with and without values", () => {
    expect(forbiddenHit([qualified], "set_crm_status:qualified")).toBe(true);
    expect(forbiddenHit([qualified], "set_crm_status:disagreed")).toBe(false);
    expect(forbiddenHit([owner], "set_contact_type")).toBe(true);
  });

  it("builds listings with merged rental terms", () => {
    const listing = buildListing({
      crm_status: "agreed",
      rentalTerms: { availability_status: "available", minimum_lease_months: 12 },
    });
    expect(listing.crm_status).toBe("agreed");
    expect(listing.rental_terms?.availability_status).toBe("available");
    expect(listing.rental_terms?.minimum_lease_months).toBe(12);
    expect(listing.rental_terms?.price).toBe(900);
  });

  it("flags realtor stop scenario when qualification continues", () => {
    const scenario = scenarios.find((s) => s.name === "realtor")!;
    const failures = evaluate(
      scenario,
      [{ type: "set_contact_type", contactType: "realtor" }, qualified],
      buildListing({ contact_type: "realtor" }),
      false,
      [],
    );
    expect(failures).toContain("forbidden action set_crm_status:qualified");
    expect(failures).toContain("expected stopConversation=true");
  });

  it("flags hallucinated data keys and dead-end replies", () => {
    const scenario = { ...scenarios.find((s) => s.name === "live-regression-terse-consent")!,
      transitionReplies: [{ fromStatus: "read", toStatus: "agreed", replyMustContain: ["вид из окон", "жк"] }] };
    const failures = evaluate(
      scenario,
      [
        { type: "set_crm_status", status: "agreed" },
        { type: "update_rental_terms", data: { price: 600, commission_type: "fixed", commission_payer: "owner" } },
      ],
      buildListing({ contact_type: "owner", crm_status: "agreed", rentalTerms: { price: 600, minimum_lease_months: 12 } }),
      false,
      [
        { crmStatusBefore: "delivered", crmStatusAfter: "read", actions: [], reply: "Сдаётся?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Вы собственник?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Условия?", stopped: false },
        {
          crmStatusBefore: "read",
          crmStatusAfter: "agreed",
          actions: [{ type: "set_crm_status", status: "agreed" }],
          reply: "Принял. 😊",
          stopped: false,
        },
      ],
    );
    expect(failures.some((f) => f.startsWith("forbidden data key update_rental_terms.commission_type"))).toBe(true);
    expect(failures.some((f) => f.startsWith("reply on read -> agreed transition missing"))).toBe(true);
    expect(failures.some((f) => f.startsWith("turn 4 reply must end with a question"))).toBe(true);
  });

  it("passes a correct agreement transition with the phase-2 pack", () => {
    const scenario = { ...scenarios.find((s) => s.name === "live-regression-terse-consent")!,
      transitionReplies: [{ fromStatus: "read", toStatus: "agreed", replyMustContain: ["вид из окон", "жк"] }] };
    const failures = evaluate(
      scenario,
      [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_rental_terms", data: { price: 600, minimum_lease_months: 12 } },
        { type: "set_crm_status", status: "agreed" },
      ],
      buildListing({ contact_type: "owner", crm_status: "agreed", rentalTerms: { price: 600, minimum_lease_months: 12 } }),
      false,
      [
        { crmStatusBefore: "delivered", crmStatusAfter: "read", actions: [], reply: "Сдаётся?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Вы собственник?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Условия?", stopped: false },
        {
          crmStatusBefore: "read",
          crmStatusAfter: "agreed",
          actions: [{ type: "set_crm_status", status: "agreed" }],
          reply: "Спасибо! Уточню сразу: — Какой вид из окон? — Квартира в каком ЖК?",
          stopped: false,
        },
      ],
    );
    expect(failures).toEqual([]);
  });

  it("checks every continuing turn, not just the final reply", () => {
    const scenario = scenarios.find((s) => s.name === "owner-simple")!;
    const failures = evaluate(
      scenario,
      [],
      buildListing({ contact_type: "owner", crm_status: "agreed", rentalTerms: { price: 600, minimum_lease_months: 12 } }),
      false,
      [
        { crmStatusBefore: "delivered", crmStatusAfter: "read", actions: [], reply: "Принял.", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Спасибо, какой срок аренды?", stopped: false },
        {
          crmStatusBefore: "read",
          crmStatusAfter: "agreed",
          actions: [{ type: "set_crm_status", status: "agreed" }],
          reply: "Какой вид из окон и ЖК?",
          stopped: false,
        },
      ],
    );
    expect(failures).toContain("turn 1 reply must end with a question while the conversation continues: Принял.");
  });

  it("requires the agreement transition reply to ask the phase-2 questions", () => {
    const scenario = { ...scenarios.find((s) => s.name === "live-regression-terse-consent")!,
      transitionReplies: [{ fromStatus: "read", toStatus: "agreed", replyMustContain: ["вид из окон", "жк"] }] };
    const failures = evaluate(
      scenario,
      [],
      buildListing({ contact_type: "owner", crm_status: "agreed", rentalTerms: { price: 600, minimum_lease_months: 12 } }),
      false,
      [
        { crmStatusBefore: "delivered", crmStatusAfter: "read", actions: [], reply: "Я собственник?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Спасибо, срок какой?", stopped: false },
        { crmStatusBefore: "read", crmStatusAfter: "read", actions: [], reply: "Доступна сейчас?", stopped: false },
        {
          crmStatusBefore: "read",
          crmStatusAfter: "read",
          actions: [{ type: "set_crm_status", status: "agreed" }],
          reply: "Какой вид из окон и ЖК?",
          stopped: false,
        },
      ],
    );
    expect(failures).toContain("missing CRM transition read -> agreed");
  });

  it("checks exact-turn status, CRM fields, actions, and reply", () => {
    const scenario = scenarios.find((s) => s.name === "adversarial-transliterated-no-availability")!;
    const failures = evaluate(
      scenario,
      [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
      buildListing({ rentalTerms: { availability_status: "rented" } }),
      true,
      [
        {
          crmStatusBefore: "delivered",
          crmStatusAfter: "delivered",
          crmStateAfter: { crm_status: "delivered", contact_type: "potential_owner", rentalTerms: { availability_status: "rented" } },
          actions: [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
          reply: "Понял, квартира уже сдана. Если снова станет доступна, напишите.",
          stopped: true,
        },
      ],
    );
    expect(failures).toEqual([]);
  });

  it("fails an exact turn when it invents cooperation status or lacks its reply", () => {
    const scenario = scenarios.find((s) => s.name === "adversarial-ambiguous-yes-to-two-questions")!;
    const failures = evaluate(
      scenario,
      [{ type: "set_crm_status", status: "agreed" }],
      buildListing({ crm_status: "agreed", contact_type: "owner" }),
      false,
      [
        {
          crmStatusBefore: "delivered",
          crmStatusAfter: "agreed",
          crmStateAfter: { crm_status: "agreed", contact_type: "owner" },
          actions: [{ type: "set_crm_status", status: "agreed" }, { type: "set_contact_type", contactType: "owner" }],
          reply: "Спасибо.",
          stopped: false,
        },
      ],
    );
    expect(failures).toContain("forbidden action set_crm_status:agreed");
    expect(failures).toContain("turn 1 forbidden action set_contact_type:owner");
    expect(failures).toContain("turn 1 ended with CRM status agreed, expected delivered");
    expect(failures).toContain("turn 1 CRM contact_type=owner expected potential_owner");
    expect(failures.some((failure) => failure.includes("reply"))).toBe(true);
  });
});
