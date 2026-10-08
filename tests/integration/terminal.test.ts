import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { CrmClient } from "../../src/crm/crm.client";
import { Listing } from "../../src/types";

function stubCrm(listings: Listing[]): CrmClient {
  return {
    getListingsByPhone: vi.fn(async () => listings),
    getInteractions: vi.fn(async () => []),
    setStatus: vi.fn(async () => undefined),
    setContactType: vi.fn(async () => undefined),
    updateDealInfo: vi.fn(async () => undefined),
    updateRentalTerms: vi.fn(async () => undefined),
    getComplexes: vi.fn(async () => []),
  };
}

describe("terminal and manager filtering", () => {
  it("marks a multi-listing realtor without asking which apartment, then stays silent", async () => {
    const harness = createHarness({ TERMINAL_CRM_STATUSES: "disagreed,archived,no_whatsapp" });
    const phone = "+995555700008";
    harness.crm.setContactState(phone, {
      status: "delivered", contactType: "potential_owner",
      listings: [{ id: 101 }, { id: 102 }] as never,
    });
    harness.llm.responder = messages => JSON.stringify(
      messages.some(message => message.role === "system" && message.content.startsWith("CRM_EXECUTION_RESULTS:"))
        ? { reply: "Спасибо, до свидания.", actions: [], stopConversation: true }
        : { reply: "Спасибо, до свидания.", actions: [{ type: "set_crm_status", status: "realtor" }], stopConversation: false },
    );
    const instanceId = harness.config.instances[0].id;
    const chatId = "995555700008@c.us";
    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "Я риэлтор, сдаю эти квартиры" }));
    const first = (await harness.scheduler.runAll())[0];
    expect(first?.status).toBe("processed");
    expect(first?.stopConversation).toBe(true);
    expect((await harness.crm.getListingsByPhone(phone)).map(listing => listing.crm_status)).toEqual(["realtor", "realtor"]);
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
    const modelCalls = harness.llm.calls.length;
    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "Есть новости?" }));
    expect((await harness.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(modelCalls);
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
  });

  it("leaves Telegram partners outside owner outreach even with an AI manager", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "new", contact_type: "partner", assigned_manager_id: 2, assigned_manager_is_ai: true },
    ]);
    await harness.ingest(harness.makeMessage({
      instanceId: harness.config.instances[0].id,
      chatId: "995555700009@c.us", text: "Я агент, добавил квартиру через Telegram",
    }));
    expect((await harness.scheduler.runAll())[0]?.status).toBe("skipped");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
    expect(harness.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("keeps removed contacts silent even if not configured as terminal", async () => {
    const harness = createHarness({ TERMINAL_CRM_STATUSES: "disagreed,archived,no_whatsapp" });
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "listing_removed", assigned_manager_id: 2 },
      { id: 2, crm_status: "listing_removed", assigned_manager_id: 2 },
    ]);
    await harness.ingest(harness.makeMessage({
      instanceId: harness.config.instances[0].id, chatId: "995555700001@c.us", text: "Хорошо спасибо",
    }));
    expect((await harness.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
    expect(harness.debug.snapshot().crmActions).toHaveLength(0);
  });

  it("saves already rented, closes the contact, and stays silent on thanks", async () => {
    const harness = createHarness();
    harness.llm.responder = (messages) => JSON.stringify({
      reply: "Понял, спасибо за информацию.",
      actions: messages.some(message => message.content.startsWith("CRM_EXECUTION_RESULTS:"))
        ? [] : [{ type: "update_rental_terms", data: { availability_status: "rented" } }],
      stopConversation: false,
    });
    const phone = "995555700005";
    const message = (text: string) => harness.makeMessage({
      instanceId: harness.config.instances[0].id, chatId: `${phone}@c.us`, text,
    });
    await harness.ingest(message("Уже сдалась"));
    const first = (await harness.scheduler.runAll())[0];
    expect(first?.status).toBe("processed");
    expect(first?.stopConversation).toBe(true);
    const listings = await harness.crm.getListingsByPhone(phone);
    expect(listings[0].rental_terms?.availability_status).toBe("rented");
    expect(listings[0].crm_status).toBe("listing_removed");
    await harness.ingest(message("Хорошо спасибо"));
    expect((await harness.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(2);
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
  });

  it("does not restart historical rented listings left in read", async () => {
    const harness = createHarness();
    harness.services.crm = stubCrm([
      { id: 1, crm_status: "read", assigned_manager_id: 2, rental_terms: { availability_status: "rented" } },
    ]);
    await harness.ingest(harness.makeMessage({
      instanceId: harness.config.instances[0].id, chatId: "995555700001@c.us", text: "Хорошо спасибо",
    }));
    expect((await harness.scheduler.runAll())[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
  });
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

  it("stops qualified contacts even when the environment omits qualified", async () => {
    const harness = createHarness({ TERMINAL_CRM_STATUSES: "disagreed,archived,no_whatsapp" });
    harness.services.crm = stubCrm([
      {
        id: 1,
        crm_status: "qualified",
        contact_type: "owner",
        assigned_manager_id: 2,
        rental_terms: { price_period: "month" },
      },
    ]);
    await harness.ingest(
      harness.makeMessage({
        instanceId: harness.config.instances[0].id,
        chatId: "995555700004@c.us",
        text: "Есть новости по арендаторам?",
      }),
    );
    const outcomes = await harness.scheduler.runAll();

    expect(outcomes[0]?.status).toBe("terminal");
    expect(harness.llm.calls).toHaveLength(0);
    expect(harness.debug.snapshot().outgoing).toHaveLength(0);
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
