import { describe, expect, it, vi } from "vitest";
import {
  filterListingsByManager,
  isTerminalListing,
  parseConversationKey,
} from "../../src/conversation/conversation.service";
import { resolvePhase } from "../../src/agent/system-prompt";
import { executeActions, matchComplex } from "../../src/agent/actions";
import { Listing } from "../../src/types";
import { CrmClient, ResidentialComplex } from "../../src/crm/crm.client";
import { InMemoryDebugRecorder } from "../../src/observability/debug-recorder";
import { createLogger } from "../../src/observability/logger";

const listing = (overrides: Partial<Listing> = {}): Listing => ({
  id: 1,
  assigned_manager_id: 2,
  ...overrides,
});

describe("business rules", () => {
  it("treats disagreed, archived and no_whatsapp as terminal", () => {
    const terminal = ["disagreed", "archived", "no_whatsapp"];
    expect(isTerminalListing(listing({ crm_status: "disagreed" }), terminal)).toBe(true);
    expect(isTerminalListing(listing({ crm_status: "archived" }), terminal)).toBe(true);
    expect(isTerminalListing(listing({ crm_status: "no_whatsapp" }), terminal)).toBe(true);
  });

  it("does not treat qualified as terminal — it gets substantive replies", () => {
    expect(isTerminalListing(listing({ crm_status: "qualified" }), ["disagreed", "archived", "no_whatsapp"])).toBe(false);
    expect(isTerminalListing(listing({ crm_status: "delivered" }), ["disagreed", "archived", "no_whatsapp"])).toBe(false);
  });

  it("treats realtor contact type as terminal", () => {
    const terminal = ["disagreed", "archived", "no_whatsapp"];
    expect(isTerminalListing(listing({ contact_type: "realtor" }), terminal)).toBe(true);
    expect(isTerminalListing(listing({ contact_type: "owner" }), terminal)).toBe(false);
  });

  it("resolves conversation phase from crm_status", () => {
    expect(resolvePhase("new")).toBe("primary");
    expect(resolvePhase("sent")).toBe("primary");
    expect(resolvePhase("delivered")).toBe("primary");
    expect(resolvePhase("read")).toBe("primary");
    expect(resolvePhase(undefined)).toBe("primary");
    expect(resolvePhase("agreed")).toBe("agreed");
    expect(resolvePhase("qualified")).toBe("qualified");
  });

  it("filters listings by per-instance manager id", () => {
    const listings = [
      listing({ id: 1, assigned_manager_id: 2 }),
      listing({ id: 2, assigned_manager_id: 7 }),
    ];
    expect(filterListingsByManager(listings, 2, []).map((l) => l.id)).toEqual([1]);
  });

  it("filters listings by allowed manager ids", () => {
    const listings = [
      listing({ id: 1, assigned_manager_id: 2 }),
      listing({ id: 2, assigned_manager_id: 7 }),
    ];
    expect(filterListingsByManager(listings, undefined, [2, 7]).map((l) => l.id)).toEqual([1, 2]);
    expect(filterListingsByManager(listings, undefined, [2]).map((l) => l.id)).toEqual([1]);
  });

  it("serves AI-flagged managers regardless of the legacy id list", () => {
    const listings = [
      listing({ id: 1, assigned_manager_id: 9, assigned_manager_is_ai: true }),
      listing({ id: 2, assigned_manager_id: 2, assigned_manager_is_ai: false }),
    ];
    expect(filterListingsByManager(listings, undefined, [2]).map((l) => l.id)).toEqual([1]);
    expect(filterListingsByManager(listings, undefined, []).map((l) => l.id)).toEqual([1]);
  });

  it("falls back to allowed manager ids when the AI flag is unknown", () => {
    const listings = [
      listing({ id: 1, assigned_manager_id: 2, assigned_manager_is_ai: null }),
      listing({ id: 2, assigned_manager_id: 7, assigned_manager_is_ai: null }),
    ];
    expect(filterListingsByManager(listings, undefined, [2]).map((l) => l.id)).toEqual([1]);
  });

  it("allows all listings when no manager filter is configured", () => {
    const listings = [
      listing({ id: 1, assigned_manager_id: 2 }),
      listing({ id: 2, assigned_manager_id: null }),
    ];
    expect(filterListingsByManager(listings, undefined, [])).toHaveLength(2);
  });

  it("parses conversation keys", () => {
    expect(parseConversationKey("instance1:user1@c.us")).toEqual({
      instanceId: "instance1",
      chatId: "user1@c.us",
    });
  });
});

describe("complex matching", () => {
  const complexes: ResidentialComplex[] = [
    { id: 1, name: "Orbi City" },
    { id: 2, name: "Batumi Towers" },
  ];

  it("matches exact names case-insensitively", () => {
    expect(matchComplex(complexes, "orbi city")?.id).toBe(1);
    expect(matchComplex(complexes, "Batumi Towers")?.id).toBe(2);
  });

  it("does not match unknown complexes or no-complex markers", () => {
    expect(matchComplex(complexes, "Orbi City 2")).toBeNull();
    expect(matchComplex(complexes, "нет ЖК")).toBeNull();
    expect(matchComplex(complexes, "-")).toBeNull();
    expect(matchComplex(complexes, "")).toBeNull();
  });
});

describe("executeActions", () => {
  const logger = createLogger({ level: "silent", pretty: false });

  function makeCrm(): CrmClient & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      getListingsByPhone: vi.fn(async () => []),
      setStatus: vi.fn(async (id, status) => {
        calls.push(`status:${id}:${status}`);
      }),
      setContactType: vi.fn(async (_phone, type) => {
        calls.push(`type:${type}`);
      }),
      updateDealInfo: vi.fn(async (_phone, listingId, data) => {
        calls.push(`deal:${listingId}:${JSON.stringify(data)}`);
      }),
      updateRentalTerms: vi.fn(async (_phone, listingId, data) => {
        calls.push(`rental:${listingId}:${JSON.stringify(data)}`);
      }),
      getComplexes: vi.fn(async () => [
        { id: 1, name: "Orbi City" },
        { id: 2, name: "Batumi Towers" },
      ]),
    };
  }

  it("executes validated rent actions against the CRM", async () => {
    const crm = makeCrm();
    const executed = await executeActions(
      [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_deal_info", data: { window_view: "море", complex_name: "Orbi City" } },
        {
          type: "update_rental_terms",
          listingId: 101,
          data: { price: 900, currency: "USD", minimum_lease_months: 12 },
        },
        { type: "set_crm_status", status: "agreed" },
      ],
      {
        crm,
        logger,
        debug: new InMemoryDebugRecorder(),
        phone: "+995555123456",
        primaryListingId: 101,
      },
    );

    expect(executed).toEqual([
      "set_contact_type",
      "update_deal_info",
      "update_rental_terms",
      "set_crm_status",
    ]);
    expect(crm.calls).toContain("type:owner");
    expect(crm.calls.some((c) => c.startsWith("deal:101:") && c.includes("residential_complex_id"))).toBe(true);
    expect(crm.calls).toContain('rental:101:{"price":900,"currency":"USD","minimum_lease_months":12}');
    expect(crm.calls).toContain("status:101:agreed");
  });

  it("uses the action listingId when provided", async () => {
    const crm = makeCrm();
    await executeActions([{ type: "set_crm_status", status: "agreed", listingId: 555 }], {
      crm,
      logger,
      debug: new InMemoryDebugRecorder(),
      phone: "+995555123456",
      primaryListingId: 101,
    });
    expect(crm.calls).toContain("status:555:agreed");
  });

  it("does not assign complex id for the no-complex marker", async () => {
    const crm = makeCrm();
    await executeActions(
      [{ type: "update_deal_info", data: { complex_name: "нет ЖК" } }],
      {
        crm,
        logger,
        debug: new InMemoryDebugRecorder(),
        phone: "+995555123456",
        primaryListingId: 101,
      },
    );
    expect(crm.calls[0]).toBe('deal:101:{"complex_name":"нет ЖК"}');
  });

  it("does not write extra rental terms when moving to agreed", async () => {
    const crm = makeCrm();
    await executeActions([{ type: "set_crm_status", status: "agreed", listingId: 101 }], {
      crm,
      logger,
      debug: new InMemoryDebugRecorder(),
      phone: "+995555123456",
      primaryListingId: 101,
    });
    expect(crm.calls.filter((c) => c.startsWith("rental:"))).toEqual([]);
    expect(crm.calls).toContain("status:101:agreed");
    expect(crm.setStatus).toHaveBeenCalledWith(101, "agreed", { suppressTelegram: true });
  });

});
