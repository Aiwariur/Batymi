import { describe, expect, it } from "vitest";
import {
  chatReplyResponseSchema,
  complexesResponseSchema,
  listingsResponseSchema,
  rentalTermsResponseSchema,
} from "../../src/crm/crm.schemas";

const listingPayload = {
  id: 101,
  external_id: 101,
  title: "2-комн. квартира",
  address: "Batumi, Kobaladze 24",
  price: 900,
  currency: "USD",
  phone: "+995555000001",
  contact_name: "Owner",
  crm_status: "delivered",
  contact_type: "potential_owner",
  assigned_manager_id: 2,
  is_active: true,
  window_view: null,
  cadastral_code: null,
  complex_name: null,
  rental_terms: {
    listing_id: 101,
    price: 900,
    currency: "USD",
    transaction_type: "rent_long_term",
    price_period: "month",
    deposit_amount: null,
    minimum_lease_months: null,
    availability_status: "unknown",
    commission_type: null,
    commission_value: null,
    commission_payer: "unknown",
  },
};

describe("crm schemas", () => {
  it("parses nested rental terms without retaining unsupported fields", () => {
    const parsed = listingsResponseSchema.parse({
      success: true,
      count: 1,
      flats: [{
        ...listingPayload,
        rental_terms: { ...listingPayload.rental_terms, publication_consent: true },
      }],
    });
    const listing = parsed.flats[0];
    expect(listing.id).toBe(101);
    expect(listing.crm_status).toBe("delivered");
    expect(listing.rental_terms?.transaction_type).toBe("rent_long_term");
    expect(listing.rental_terms?.price_period).toBe("month");
    expect(listing.rental_terms).not.toHaveProperty("publication_consent");
  });

  it("coerces numeric field types coming from the legacy dict", () => {
    const parsed = listingsResponseSchema.parse({
      flats: [{ ...listingPayload, rooms: "2", area: "55.5", is_active: 1 }],
    });
    expect(parsed.flats[0].rooms).toBe("2");
    expect(parsed.flats[0].is_active).toBe(true);
  });

  it("normalizes amenity dict options from CRM into a list of keys", () => {
    const parsed = listingsResponseSchema.parse({
      flats: [
        {
          ...listingPayload,
          options: { wifi: true, furniture: true, dishwasher: false, balcony: "есть" },
        },
      ],
    });
    expect(parsed.flats[0].options).toEqual(["wifi", "furniture", "balcony: есть"]);
  });

  it("stringifies object items inside options arrays", () => {
    const parsed = listingsResponseSchema.parse({
      flats: [{ ...listingPayload, options: [{ name: "wifi", value: true }, "terrace"] }],
    });
    expect(parsed.flats[0].options).toEqual([JSON.stringify({ name: "wifi", value: true }), "terrace"]);
  });

  it("parses the rental-terms update response", () => {
    const parsed = rentalTermsResponseSchema.parse({
      success: true,
      ok: true,
      listing_id: 101,
      changed_fields: ["price", "minimum_lease_months"],
    });
    expect(parsed.changed_fields).toEqual(["price", "minimum_lease_months"]);
  });

  it("parses the complexes catalog response", () => {
    const parsed = complexesResponseSchema.parse({
      success: true,
      complexes: [{ id: 1, name: "Orbi City" }],
    });
    expect(parsed.complexes?.[0]).toEqual({ id: 1, name: "Orbi City" });
  });

  it("parses the /chat/reply response", () => {
    const parsed = chatReplyResponseSchema.parse({
      success: true,
      message_id: "3EB0E5D",
      instance_id: "1101234567",
    });
    expect(parsed.message_id).toBe("3EB0E5D");
  });
});
