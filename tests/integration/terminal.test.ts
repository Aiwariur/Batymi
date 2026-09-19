import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { CrmClient } from "../../src/crm/crm.client";
import { Flat } from "../../src/types";

function stubCrm(flats: Flat[]): CrmClient {
  return {
    getFlatsByPhone: vi.fn(async () => flats),
    setStatus: vi.fn(async () => undefined),
    setContactType: vi.fn(async () => undefined),
    updateDealInfo: vi.fn(async () => undefined),
  };
}

describe("terminal and manager filtering", () => {
  it("does not run qualification for terminal conversations", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "qualified", contact_type: "owner", assigned_manager_id: 2 },
    ]);

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700001@c.us",
        text: "Есть покупатели?",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("treats realtor conversations as terminal", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "delivered", contact_type: "realtor", assigned_manager_id: 2 },
    ]);

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700002@c.us",
        text: "Есть покупатель",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
  });

  it("skips flats that belong to another manager", async () => {
    const harness = createHarness({ ALLOWED_MANAGER_IDS: "2" });
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "delivered", assigned_manager_id: 99 },
    ]);

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700003@c.us",
        text: "Да, продаётся",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("skipped");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
  });
});
