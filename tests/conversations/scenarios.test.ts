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
];

describe("conversation scenario suite", () => {
  it("has at least 25 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(25);
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
    );
    expect(failures).toContain("forbidden action set_crm_status:qualified");
    expect(failures).toContain("expected stopConversation=true");
  });
});
