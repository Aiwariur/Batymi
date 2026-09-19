import { describe, expect, it, vi } from "vitest";
import {
  filterFlatsByManager,
  isTerminalFlat,
  parseConversationKey,
} from "../../src/conversation/conversation.service";
import { executeActions } from "../../src/agent/actions";
import { Flat } from "../../src/types";
import { CrmClient } from "../../src/crm/crm.client";
import { InMemoryDebugRecorder } from "../../src/observability/debug-recorder";
import { createLogger } from "../../src/observability/logger";

const flat = (overrides: Partial<Flat> = {}): Flat => ({ id: 1, assigned_manager_id: 2, ...overrides });

describe("business rules", () => {
  it("treats qualified and disagreed as terminal", () => {
    expect(isTerminalFlat(flat({ crm_status: "qualified" }), ["qualified", "disagreed"])).toBe(true);
    expect(isTerminalFlat(flat({ crm_status: "disagreed" }), ["qualified", "disagreed"])).toBe(true);
    expect(isTerminalFlat(flat({ crm_status: "delivered" }), ["qualified", "disagreed"])).toBe(false);
  });

  it("treats realtor contact type as terminal", () => {
    expect(isTerminalFlat(flat({ contact_type: "realtor" }), ["qualified", "disagreed"])).toBe(true);
    expect(isTerminalFlat(flat({ contact_type: "owner" }), ["qualified", "disagreed"])).toBe(false);
  });

  it("filters flats by per-instance manager id", () => {
    const flats = [flat({ id: 1, assigned_manager_id: 2 }), flat({ id: 2, assigned_manager_id: 7 })];
    expect(filterFlatsByManager(flats, 2, []).map((f) => f.id)).toEqual([1]);
  });

  it("filters flats by allowed manager ids", () => {
    const flats = [flat({ id: 1, assigned_manager_id: 2 }), flat({ id: 2, assigned_manager_id: 7 })];
    expect(filterFlatsByManager(flats, undefined, [2, 7]).map((f) => f.id)).toEqual([1, 2]);
    expect(filterFlatsByManager(flats, undefined, [2]).map((f) => f.id)).toEqual([1]);
  });

  it("allows all flats when no manager filter is configured", () => {
    const flats = [flat({ id: 1, assigned_manager_id: 2 }), flat({ id: 2, assigned_manager_id: null })];
    expect(filterFlatsByManager(flats, undefined, [])).toHaveLength(2);
  });

  it("parses conversation keys", () => {
    expect(parseConversationKey("instance1:user1@c.us")).toEqual({
      instanceId: "instance1",
      chatId: "user1@c.us",
    });
  });
});

describe("executeActions", () => {
  const logger = createLogger({ level: "silent", pretty: false });

  function makeCrm(): CrmClient & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      getFlatsByPhone: vi.fn(async () => []),
      setStatus: vi.fn(async (id, status) => {
        calls.push(`status:${id}:${status}`);
      }),
      setContactType: vi.fn(async (_phone, type) => {
        calls.push(`type:${type}`);
      }),
      updateDealInfo: vi.fn(async () => {
        calls.push("deal");
      }),
    };
  }

  it("executes validated actions against the CRM", async () => {
    const crm = makeCrm();
    const executed = await executeActions(
      [
        { type: "set_contact_type", contactType: "owner" },
        { type: "update_deal_info", data: {
          commission_type: "on_top",
          commission_value: "",
          price_net: "85000",
          window_view: "море",
          complex_name: "",
          cadastral_code: "",
          agent_notes: "",
        } },
        { type: "set_crm_status", status: "qualified" },
      ],
      {
        crm,
        logger,
        debug: new InMemoryDebugRecorder(),
        phone: "+995555123456",
        primaryFlatId: 101,
      },
    );

    expect(executed).toEqual(["set_contact_type", "update_deal_info", "set_crm_status"]);
    expect(crm.calls).toContain("type:owner");
    expect(crm.calls).toContain("deal");
    expect(crm.calls).toContain("status:101:qualified");
  });

  it("uses the action flatId when provided", async () => {
    const crm = makeCrm();
    await executeActions([{ type: "set_crm_status", status: "agreed", flatId: 555 }], {
      crm,
      logger,
      debug: new InMemoryDebugRecorder(),
      phone: "+995555123456",
      primaryFlatId: 101,
    });
    expect(crm.calls).toContain("status:555:agreed");
  });
});
