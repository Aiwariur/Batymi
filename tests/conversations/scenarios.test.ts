import { describe, expect, it } from "vitest";
import { baseFlat, scenarios } from "./scenarios";
import { actionMatches, evaluate, forbiddenHit } from "./evaluate";
import { AgentAction } from "../../src/agent/schemas";

const REQUIRED_SCENARIOS = [
  "owner-simple",
  "realtor",
  "owner-gives-everything-at-once",
  "owner-short-answers",
  "owner-changes-price",
  "owner-no-complex",
  "owner-gives-commission-percent",
  "owner-wants-net-price",
  "owner-refuses",
  "owner-soft-objection",
  "bad-address",
  "multiple-flats",
  "already-known-fields",
  "user-corrects-crm-data",
  "several-messages-at-once",
  "confirmation",
];

describe("conversation scenario suite", () => {
  it("has at least 20 scenarios", () => {
    expect(scenarios.length).toBeGreaterThanOrEqual(20);
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
        expect(forbidden).toMatch(/^(set_contact_type|set_crm_status|update_deal_info)(:.*)?$/);
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

  it("flags realtor stop scenario when qualification continues", () => {
    const scenario = scenarios.find((s) => s.name === "realtor")!;
    const failures = evaluate(
      scenario,
      [{ type: "set_contact_type", contactType: "realtor" }, qualified],
      { ...baseFlat, contact_type: "realtor" },
      false,
    );
    expect(failures).toContain("forbidden action set_crm_status:qualified");
    expect(failures).toContain("expected stopConversation=true");
  });
});
