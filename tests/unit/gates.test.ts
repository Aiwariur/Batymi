import { describe, expect, it } from "vitest";
import { applyGates, qualifiedMissingFields } from "../../src/agent/gates";
import { Listing } from "../../src/types";

const baseListing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 101,
  crm_status: "delivered",
  contact_type: "potential_owner",
  assigned_manager_id: 2,
  window_view: null,
  cadastral_code: null,
  complex_name: null,
  rental_terms: {
    listing_id: 101,
    price: 900,
    currency: "USD",
    transaction_type: "rent_long_term",
    price_period: "month",
    availability_status: "unknown",
    minimum_lease_months: null,
    commission_type: null,
  },
  ...overrides,
});

const ctx = (listings: Listing[], phase: "primary" | "agreed" | "qualified" = "primary") => ({
  listings,
  primaryListingId: listings[0].id,
  phase,
});

describe("status gates", () => {
  it("rejects statuses that only the CRM itself may set", () => {
    for (const status of ["sent", "new", "sold", "archived", "no_whatsapp"]) {
      const result = applyGates(
        [{ type: "set_crm_status", status: status as never }],
        ctx([baseListing()]),
      );
      expect(result.rejected[0]?.reason).toBe("forbidden_status");
      expect(result.allowed).toHaveLength(0);
    }
  });

  it("rejects qualified in the primary phase", () => {
    const result = applyGates(
      [{ type: "set_crm_status", status: "qualified" }],
      ctx([baseListing()]),
    );
    expect(result.rejected[0]?.reason).toBe("qualified_not_in_primary_phase");
  });

  it("does not allow status to regress or repeat after cooperation was agreed", () => {
    const result = applyGates(
      [
        { type: "set_crm_status", status: "agreed" },
        { type: "set_crm_status", status: "disagreed" },
      ],
      ctx([baseListing({ crm_status: "agreed" })], "agreed"),
    );
    expect(result.allowed.map((action) => action.type === "set_crm_status" && action.status)).toEqual(["disagreed"]);
    expect(result.rejected).toEqual([
      expect.objectContaining({ reason: "status_already_agreed" }),
    ]);
  });

  it("rejects every action in a qualified dialog", () => {
    const result = applyGates(
      [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_deal_info", data: { window_view: "море" } },
        { type: "set_crm_status", status: "disagreed" },
      ],
      ctx([baseListing({ crm_status: "qualified" })], "qualified"),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual([
      "qualified_dialog_no_actions",
      "qualified_dialog_no_actions",
      "qualified_dialog_no_actions",
    ]);
  });
});

describe("qualified completeness gate", () => {
  const completeTerms = {
    price: 900,
    currency: "USD",
    transaction_type: "rent_long_term",
    price_period: "month",
    availability_status: "available",
    minimum_lease_months: 12,
  };

  it("lists missing fields for an empty listing", () => {
    const missing = qualifiedMissingFields(baseListing());
    expect(missing).toContain("rental_terms.availability_status");
    expect(missing).toContain("rental_terms.minimum_lease_months");
    expect(missing).not.toContain("rental_terms.commission_type");
    expect(missing).not.toContain("window_view");
    expect(missing).not.toContain("complex_name");
    expect(missing).not.toContain("cadastral_code");
  });

  it("does not treat non-positive price or lease as complete", () => {
    const missing = qualifiedMissingFields(
      baseListing({
        window_view: "море",
        complex_name: "нет ЖК",
        rental_terms: {
          ...baseListing().rental_terms!,
          ...completeTerms,
          price: 0,
          minimum_lease_months: -1,
        },
      }),
    );
    expect(missing).toEqual(
      expect.arrayContaining(["rental_terms.price", "rental_terms.minimum_lease_months"]),
    );
  });

  it("commission, window view and complex are not required for qualified", () => {
    const missing = qualifiedMissingFields(
      baseListing({
        window_view: null,
        complex_name: null,
        rental_terms: {
          ...baseListing().rental_terms!,
          ...completeTerms,
          commission_type: null,
        },
      }),
    );
    expect(missing).toHaveLength(0);
  });

  it("rejects qualified while essentials are missing", () => {
    const listing = baseListing({
      complex_name: "Orbi City",
      window_view: "море",
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms, availability_status: "unknown" },
    });
    const result = applyGates([{ type: "set_crm_status", status: "qualified" }], ctx([listing], "agreed"));
    expect(result.rejected[0]?.reason).toContain("qualified_incomplete");
    expect(result.rejected[0]?.reason).toContain("rental_terms.availability_status");
  });

  it("accepts qualified while window view is still unknown", () => {
    const listing = baseListing({
      window_view: null,
      complex_name: "Orbi City",
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms },
    });
    const result = applyGates([{ type: "set_crm_status", status: "qualified" }], ctx([listing], "agreed"));
    expect(result.rejected).toHaveLength(0);
  });

  it("accepts qualified when the same batch fills the missing fields", () => {
    const listing = baseListing({
      complex_name: "Orbi City",
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms, availability_status: "unknown" },
    });
    const result = applyGates(
      [
        { type: "update_rental_terms", data: { availability_status: "available" } },
        { type: "set_crm_status", status: "qualified" },
      ],
      ctx([listing], "agreed"),
    );
    expect(result.allowed.map((a) => a.type)).toEqual(["update_rental_terms", "set_crm_status"]);
    expect(result.rejected).toHaveLength(0);
  });

  it("does not let an unscoped or rejected write satisfy qualified", () => {
    const listing = baseListing({
      complex_name: "Orbi City",
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms, availability_status: "unknown" },
    });
    const result = applyGates(
      [
        { type: "set_crm_status", status: "qualified", listingId: 101 },
        { type: "update_deal_info", listingId: 999, data: { window_view: "море" } },
      ],
      ctx([listing], "agreed"),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected.map((item) => item.reason)).toEqual([
      "unknown_listing_id",
      "qualified_incomplete:rental_terms.availability_status",
    ]);
  });

  it("moves qualified after accepted writes even when the model orders it first", () => {
    const listing = baseListing({
      complex_name: "Orbi City",
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms, availability_status: "unknown" },
    });
    const result = applyGates(
      [
        { type: "set_crm_status", status: "qualified", listingId: 101 },
        { type: "update_rental_terms", listingId: 101, data: { availability_status: "available" } },
      ],
      ctx([listing], "agreed"),
    );
    expect(result.allowed.map((item) => item.type)).toEqual([
      "update_rental_terms",
      "set_crm_status",
    ]);
  });

  it("qualifies without cadastral code, commission, window view and complex", () => {
    const listing = baseListing({
      window_view: null,
      complex_name: null,
      cadastral_code: null,
      rental_terms: { ...baseListing().rental_terms!, ...completeTerms, commission_type: null },
    });
    const result = applyGates([{ type: "set_crm_status", status: "qualified" }], ctx([listing], "agreed"));
    expect(result.rejected).toHaveLength(0);
  });
});

describe("listing addressing gates", () => {
  it("requires an explicit listingId when the contact has several listings", () => {
    const result = applyGates(
      [{ type: "update_rental_terms", data: { price: 950 } }],
      ctx([baseListing({ id: 101 }), baseListing({ id: 102 })]),
    );
    expect(result.rejected[0]?.reason).toBe("listing_id_required_for_multiple_listings");
  });

  it("requires an explicit listingId for deal info with several listings", () => {
    const result = applyGates(
      [{ type: "update_deal_info", data: { window_view: "море" } }],
      ctx([baseListing({ id: 101 }), baseListing({ id: 102 })]),
    );
    expect(result.rejected[0]?.reason).toBe("listing_id_required_for_multiple_listings");
  });

  it("requires an explicit listingId for contact status with several listings", () => {
    const result = applyGates(
      [{ type: "set_crm_status", status: "agreed" }],
      ctx([baseListing({ id: 101 }), baseListing({ id: 102 })]),
    );
    expect(result.rejected[0]?.reason).toBe("listing_id_required_for_multiple_listings");
  });

  it("defaults to the primary listing when there is only one", () => {
    const result = applyGates(
      [{ type: "update_rental_terms", data: { price: 950 } }],
      ctx([baseListing({ id: 101 })]),
    );
    expect(result.allowed[0]).toMatchObject({ type: "update_rental_terms", listingId: 101 });
  });

  it("rejects unknown listing ids", () => {
    const result = applyGates(
      [{ type: "update_rental_terms", listingId: 999, data: { price: 950 } }],
      ctx([baseListing({ id: 101 })]),
    );
    expect(result.rejected[0]?.reason).toBe("unknown_listing_id");
  });
});

describe("field sanitation gates", () => {
  it("drops empty-string deal fields instead of sending them", () => {
    const result = applyGates(
      [
        {
          type: "update_deal_info",
          data: { window_view: "", cadastral_code: "  ", complex_name: "море", agent_notes: "" },
        },
      ],
      ctx([baseListing()]),
    );
    expect(result.allowed).toHaveLength(1);
    expect((result.allowed[0] as { data: Record<string, string> }).data).toEqual({
      complex_name: "море",
    });
  });

  it("rejects update actions with nothing to write", () => {
    const result = applyGates(
      [
        { type: "update_deal_info", data: {} },
        { type: "update_rental_terms", data: { price: undefined } },
      ],
      ctx([baseListing()]),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected.map((r) => r.reason)).toEqual(["no_fields_to_write", "no_fields_to_write"]);
  });

  it("keeps set_contact_type as-is in primary and agreed phases", () => {
    for (const phase of ["primary", "agreed"] as const) {
      const result = applyGates(
        [{ type: "set_contact_type", contactType: "owner" }],
        ctx([baseListing()], phase),
      );
      expect(result.allowed).toHaveLength(1);
    }
  });
});

describe("dedup gates against CRM state", () => {
  it("rejects rental terms that only re-send current values", () => {
    const listing = baseListing({
      rental_terms: {
        ...baseListing().rental_terms!,
        price: 900,
        currency: "USD",
        minimum_lease_months: 12,
        availability_status: "available",
      },
    });
    const result = applyGates(
      [
        {
          type: "update_rental_terms",
          data: { price: 900, currency: "USD", minimum_lease_months: 12, availability_status: "available" },
        },
      ],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("no_changes_vs_crm");
  });

  it("treats numerically equal values as duplicates regardless of format", () => {
    const listing = baseListing({
      rental_terms: {
        ...baseListing().rental_terms!,
        price: "900",
        commission_value: "100.00",
      } as Listing["rental_terms"],
    });
    const result = applyGates(
      [{ type: "update_rental_terms", data: { price: 900, commission_value: "100" } }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("no_changes_vs_crm");
  });

  it("keeps only changed fields and drops the unchanged ones", () => {
    const listing = baseListing({
      rental_terms: { ...baseListing().rental_terms!, price: 900, minimum_lease_months: 12 },
    });
    const result = applyGates(
      [{ type: "update_rental_terms", data: { price: 900, deposit_amount: 500 } }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(1);
    expect((result.allowed[0] as { data: Record<string, unknown> }).data).toEqual({
      deposit_amount: 500,
    });
  });

  it("rejects deal info that re-sends current values", () => {
    const listing = baseListing({ window_view: "море", complex_name: "нет ЖК" });
    const result = applyGates(
      [{ type: "update_deal_info", data: { window_view: "море", complex_name: "нет ЖК" } }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("no_changes_vs_crm");
  });

  it("keeps deal info with at least one changed field", () => {
    const listing = baseListing({ window_view: "море" });
    const result = applyGates(
      [{ type: "update_deal_info", data: { window_view: "море", complex_name: "Orbi City" } }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(1);
    expect((result.allowed[0] as { data: Record<string, unknown> }).data).toEqual({
      complex_name: "Orbi City",
    });
  });

  it("rejects set_contact_type that matches the current contact type", () => {
    const listing = baseListing({ contact_type: "owner" });
    const result = applyGates(
      [{ type: "set_contact_type", contactType: "owner" }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(0);
    expect(result.rejected[0]?.reason).toBe("unchanged_contact_type");
  });

  it("allows set_contact_type when the type actually changes", () => {
    const listing = baseListing({ contact_type: "potential_owner" });
    const result = applyGates(
      [{ type: "set_contact_type", contactType: "owner" }],
      ctx([listing]),
    );
    expect(result.allowed).toHaveLength(1);
  });
});
