import { describe, expect, it } from "vitest";
import { flatsResponseSchema, contactResponseSchema } from "../../src/crm/crm.schemas";

describe("CRM schemas", () => {
  it("accepts a valid flats response and coerces numeric fields to strings", () => {
    const parsed = flatsResponseSchema.safeParse({
      flats: [
        {
          id: 123,
          crm_status: "delivered",
          price: 95000,
          assigned_manager_id: 2,
          contact_type: "owner",
        },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.flats[0].id).toBe(123);
      expect(parsed.data.flats[0].price).toBe("95000");
      expect(parsed.data.flats[0].assigned_manager_id).toBe(2);
    }
  });

  it("rejects a response without the flats array", () => {
    expect(flatsResponseSchema.safeParse({ data: [] }).success).toBe(false);
  });

  it("rejects a response where flats is not an array", () => {
    expect(flatsResponseSchema.safeParse({ flats: "nope" }).success).toBe(false);
  });

  it("rejects a flat without an id", () => {
    expect(flatsResponseSchema.safeParse({ flats: [{ crm_status: "new" }] }).success).toBe(false);
  });

  it("accepts a contact response", () => {
    expect(
      contactResponseSchema.safeParse({ ok: true, phone_number: "+995555123456", contact_type: "owner" })
        .success,
    ).toBe(true);
  });
});
