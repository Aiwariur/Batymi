import { describe, expect, it } from "vitest";
import {
  actionSchema,
  agentResultSchema,
  rentalTermsDataSchema,
} from "../../src/agent/schemas";

describe("agent action schemas", () => {
  it("accepts the four rent actions", () => {
    expect(
      actionSchema.safeParse({ type: "set_contact_type", contactType: "owner" }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({ type: "set_contact_type", contactType: "OWNER" }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({
        type: "update_deal_info",
        listingId: 101,
        data: { window_view: "море", complex_name: "нет ЖК" },
      }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({
        type: "update_rental_terms",
        listingId: 101,
        data: { price: 900, currency: "usd", publication_consent: true },
      }).success,
    ).toBe(true);
    expect(
      actionSchema.safeParse({ type: "set_crm_status", status: "qualified" }).success,
    ).toBe(true);
  });

  it("rejects arbitrary tool calls", () => {
    expect(
      actionSchema.safeParse({ type: "send_http_request", url: "https://x" }).success,
    ).toBe(false);
  });

  it("rejects statuses the agent must not set", () => {
    for (const status of ["sent", "new", "sold", "archived", "no_whatsapp"]) {
      expect(actionSchema.safeParse({ type: "set_crm_status", status }).success).toBe(false);
    }
  });

  it("rejects an invalid contact type", () => {
    expect(
      actionSchema.safeParse({ type: "set_contact_type", contactType: "superadmin" }).success,
    ).toBe(false);
  });

  it("coerces numeric strings in rental terms", () => {
    const parsed = rentalTermsDataSchema.parse({
      price: "900",
      deposit_amount: "1800",
      minimum_lease_months: "12",
      commission_value: 100,
    });
    expect(parsed).toMatchObject({
      price: 900,
      deposit_amount: 1800,
      minimum_lease_months: 12,
      commission_value: "100",
    });
  });

  it("uppercases currency and validates it", () => {
    expect(rentalTermsDataSchema.parse({ currency: "usd" }).currency).toBe("USD");
    expect(rentalTermsDataSchema.safeParse({ currency: "dollars" }).success).toBe(false);
  });

  it("validates rental enums", () => {
    expect(rentalTermsDataSchema.safeParse({ commission_type: "on_top" }).success).toBe(false);
    expect(rentalTermsDataSchema.safeParse({ commission_type: "percent_month" }).success).toBe(true);
    expect(rentalTermsDataSchema.safeParse({ availability_status: "available" }).success).toBe(true);
    expect(rentalTermsDataSchema.safeParse({ availability_status: "free" }).success).toBe(false);
  });

  it("bounds lease months", () => {
    expect(rentalTermsDataSchema.safeParse({ minimum_lease_months: 0 }).success).toBe(false);
    expect(rentalTermsDataSchema.safeParse({ minimum_lease_months: 121 }).success).toBe(false);
    expect(rentalTermsDataSchema.safeParse({ minimum_lease_months: 12 }).success).toBe(true);
  });

  it("parses a full agent result with defaults", () => {
    const parsed = agentResultSchema.parse({ reply: "ok" });
    expect(parsed.actions).toEqual([]);
    expect(parsed.stopConversation).toBe(false);
  });
});
