import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { CrmClient } from "../../src/crm/crm.client";
import { Listing } from "../../src/types";

function stubCrm(listings: Listing[]): CrmClient {
  return {
    getListingsByPhone: vi.fn(async () => listings),
    setStatus: vi.fn(async () => undefined),
    setContactType: vi.fn(async () => undefined),
    updateDealInfo: vi.fn(async () => undefined),
    updateRentalTerms: vi.fn(async () => undefined),
    getComplexes: vi.fn(async () => []),
  };
}

describe("terminal and manager filtering", () => {
  it("does not run qualification for terminal conversations", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "disagreed", contact_type: "owner", assigned_manager_id: 2 },
    ]);

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700001@c.us",
        text: "Передумал, обсуждаем?",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
  });

  it("treats archived and no_whatsapp as terminal", async () => {
    for (const crm_status of ["archived", "no_whatsapp"]) {
      const harness = createHarness();
      harness.services.crm = stubCrm([
        { id: 1, crm_status, contact_type: "owner", assigned_manager_id: 2 },
      ]);
      await harness.ingest(
        harness.makeMessage({
          instanceId: harness.config.instances[0].id,
          chatId: "995555700001@c.us",
          text: "Здравствуйте",
        }),
      );
      const outcomes = await harness.scheduler.runAll();
      expect(outcomes[0]?.status).toBe("terminal");
      expect(harness.llm.calls).toHaveLength(0);
    }
  });

  it("keeps replying to qualified contacts but blocks their actions", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      {
        id: 1,
        crm_status: "qualified",
        contact_type: "owner",
        assigned_manager_id: 2,
        rental_terms: { transaction_type: "rent_long_term", price_period: "month" },
      },
    ]);
    harness.llm.responder = () =>
      JSON.stringify({
        reply: "Да, квартира всё ещё в работе.",
        actions: [{ type: "set_crm_status", status: "disagreed" }],
        stopConversation: false,
      });

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700004@c.us",
        text: "Есть новости по арендаторам?",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("processed");
    expect(harness.llm.calls).toHaveLength(1);
    // Ответ ушёл, но действие CRM заблокировано гейтом qualified-фазы
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
    expect(harness.debug.snapshot().crmActions).toHaveLength(0);
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
        text: "Есть арендаторы?",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
  });

  it("skips listings that belong to another manager", async () => {
    const harness = createHarness({ ALLOWED_MANAGER_IDS: "2" });
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "delivered", assigned_manager_id: 99 },
    ]);

    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700003@c.us",
        text: "Да, сдаётся",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("skipped");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
  });
});
