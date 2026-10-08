import { describe, expect, it, vi } from "vitest";
import { handleConversationJob } from "../../src/conversation/conversation.service";
import { CrmInteraction } from "../../src/crm/crm.client";
import { SendMessageInput, SendMessageResult } from "../../src/crm/reply.sender";
import { createHarness, Harness, ScheduledJob } from "../helpers/harness";

const CHAT_ID = "995555123456@c.us";
const PHONE = "+995555123456";

function readyHarness(): Harness {
  const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
  harness.crm.setContactState(PHONE, {
    contactType: "owner",
    status: "agreed",
    listings: [{
      rental: {
        price: 900,
        currency: "USD",
        price_period: "month",
        minimum_lease_months: 12,
        availability_status: "available",
      },
    } as never],
  });
  return harness;
}

async function enqueueOwnerMessage(harness: Harness, text = "Все условия подтвердил"): Promise<string> {
  const instanceId = harness.config.instances[0].id;
  const accepted = await harness.ingest(harness.makeMessage({
    instanceId,
    chatId: CHAT_ID,
    senderPhone: PHONE,
    idMessage: `checkpoint-${Date.now()}-${Math.random()}`,
    text,
  }));
  expect(accepted.accepted).toBe(true);
  return harness.key(instanceId, CHAT_ID);
}

async function runScheduled(harness: Harness): Promise<Awaited<ReturnType<typeof handleConversationJob>>> {
  const job = harness.scheduler.take()[0];
  expect(job).toBeDefined();
  return runJob(harness, job!);
}

function runJob(harness: Harness, job: ScheduledJob) {
  return handleConversationJob(
    { conversationKey: job.conversationKey, token: job.token, retryCount: job.retryCount },
    { attemptsMade: 0, maxAttempts: 1, jobId: `recovery-${job.token}` },
    harness.services,
  );
}

function qualifiedPlan() {
  return JSON.stringify({
    reply: "Спасибо, все условия подтверждены.",
    actions: [{ type: "set_crm_status", status: "qualified", listingId: 101 }],
    stopConversation: true,
  });
}

function senderRecorder() {
  const calls: SendMessageInput[] = [];
  return {
    calls,
    sendMessage: vi.fn(async (input: SendMessageInput): Promise<SendMessageResult> => {
      calls.push(input);
      return { idMessage: `sent-${calls.length}`, mocked: true };
    }),
  };
}

describe("production owner checkpoint recovery", () => {
  it.each([true, false])("respects a manager's realtor mark during planning (with actions: %s)", async withActions => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    const sender = senderRecorder();
    harness.services.sender = sender;
    harness.crm.setContactState(PHONE, { status: "delivered", contactType: "potential_owner" });
    const setType = vi.spyOn(harness.crm, "setContactType");
    harness.llm.responder = () => {
      harness.crm.setContactState(PHONE, { status: "realtor" });
      return JSON.stringify({
        reply: "Вы согласны сотрудничать?", stopConversation: false,
        actions: withActions ? [{ type: "set_contact_type", contactType: "owner" }] : [],
      });
    };
    await enqueueOwnerMessage(harness, "Я собственник");
    expect((await runScheduled(harness)).status).toBe("skipped");
    expect(setType).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
    expect((await harness.crm.getListingsByPhone(PHONE))[0].crm_status).toBe("realtor");
  });

  it("resumes after qualified status when the final model call fails, without replaying status", async () => {
    const harness = readyHarness();
    const sender = senderRecorder();
    harness.services.sender = sender;
    const setStatus = vi.spyOn(harness.crm, "setStatus");
    let finalCalls = 0;
    harness.llm.responder = (messages) => {
      const final = messages.some(message => message.role === "system" && message.content.startsWith("CRM_EXECUTION_RESULTS:"));
      if (!final) return qualifiedPlan();
      finalCalls += 1;
      if (finalCalls === 1) throw new Error("simulated process interruption after qualification");
      return JSON.stringify({ reply: "Спасибо, я зафиксировал условия.", actions: [], stopConversation: true });
    };

    const key = await enqueueOwnerMessage(harness);
    const first = await runScheduled(harness);
    expect(first.status).toBe("rescheduled");
    expect((await harness.store.getActiveBatch(key))?.agentCheckpoint).toMatchObject({
      completedActions: 1,
    });
    expect((await harness.store.getActiveBatch(key))?.agentCheckpoint?.finalized).not.toBe(true);
    expect((await harness.crm.getListingsByPhone(PHONE))[0]?.crm_status).toBe("qualified");
    expect(sender.calls).toHaveLength(0);

    const retry = await runScheduled(harness);

    expect(retry.status).toBe("processed");
    expect(retry.reply).toBe("Спасибо, я зафиксировал условия.");
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(finalCalls).toBe(2);
    expect(sender.calls).toHaveLength(1);
    expect(await harness.store.getActiveBatch(key)).toBeNull();
  });

  it("does not duplicate a status write when CRM committed it but returned an error", async () => {
    const harness = readyHarness();
    const sender = senderRecorder();
    harness.services.sender = sender;
    const commitThenFail = harness.crm.setStatus.bind(harness.crm);
    const setStatus = vi.spyOn(harness.crm, "setStatus");
    setStatus.mockImplementationOnce(async (listingId, status, options) => {
      await commitThenFail(listingId, status, options);
      throw new Error("synthetic lost CRM response after commit");
    });
    harness.llm.responder = (messages) => messages.some(message => message.role === "system" && message.content.startsWith("CRM_EXECUTION_RESULTS:"))
      ? JSON.stringify({ reply: "Спасибо, подтверждение сохранено.", actions: [], stopConversation: true })
      : qualifiedPlan();

    const key = await enqueueOwnerMessage(harness);
    const first = await runScheduled(harness);
    expect(first.status).toBe("rescheduled");
    expect(setStatus).toHaveBeenCalledTimes(1);
    const beforeRetry = await harness.crm.getListingsByPhone(PHONE);
    expect(beforeRetry[0]?.crm_status).toBe("qualified");
    expect((await harness.store.getActiveBatch(key))?.agentCheckpoint?.completedActions).toBe(0);

    const retry = await runScheduled(harness);
    const afterRetry = await harness.crm.getListingsByPhone(PHONE);

    expect(retry.status).toBe("processed");
    expect(afterRetry).toEqual(beforeRetry);
    expect(setStatus).toHaveBeenCalledTimes(1);
    expect(sender.calls).toHaveLength(1);
  });

  it("recovers a sent outbound intent after a worker interruption without CRM, model, or send calls", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    const sender = senderRecorder();
    harness.services.sender = sender;
    const setStatus = vi.spyOn(harness.crm, "setStatus");
    const getListings = vi.spyOn(harness.crm, "getListingsByPhone");
    const key = await enqueueOwnerMessage(harness);
    const lock = await harness.store.acquireLock(key, harness.config.conversationLockTtlMs);
    expect(lock).not.toBeNull();
    const batch = await harness.store.drainPending(key);
    const active = await harness.store.getActiveBatch(key);
    expect(batch).toHaveLength(1);
    expect(active).not.toBeNull();
    const intent = await harness.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: batch[0].instanceId,
      chatId: batch[0].chatId,
      message: "Ответ уже принят CRM",
    });
    await harness.store.claimOutboundIntent(key, intent.intentId);
    await harness.store.markOutboundSent(key, intent.intentId, "crm-confirmed-1");
    await harness.store.releaseLock(key, lock!.token);

    const recovered = await runScheduled(harness);

    expect(recovered.status).toBe("processed");
    expect(recovered.reply).toBe("Ответ уже принят CRM");
    expect(harness.llm.calls).toHaveLength(0);
    expect(getListings).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
    expect(await harness.store.getActiveBatch(key)).toBeNull();
  });

  it("stops actions and sending when a manager writes during model planning", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    const sender = senderRecorder();
    harness.services.sender = sender;
    const managerMessage: CrmInteraction = {
      id: "manager-takeover-1",
      direction: "outgoing",
      text: "Я продолжу разговор лично.",
      sender: "manager",
      sent_at: new Date().toISOString(),
      instance_id: harness.config.instances[0].id,
      message_id: "manager-takeover-1",
    };
    let managerHasReplied = false;
    vi.spyOn(harness.crm, "getInteractions").mockImplementation(async () => managerHasReplied ? [managerMessage] : []);
    const setContactType = vi.spyOn(harness.crm, "setContactType");
    const setStatus = vi.spyOn(harness.crm, "setStatus");
    harness.llm.responder = () => {
      managerHasReplied = true;
      return JSON.stringify({
        reply: "Понял, уточню один момент.",
        actions: [{ type: "set_contact_type", contactType: "owner" }],
        stopConversation: false,
      });
    };

    await enqueueOwnerMessage(harness, "Я собственник");
    const outcome = await runScheduled(harness);

    expect(outcome.status).toBe("skipped");
    expect(harness.llm.calls).toHaveLength(1);
    expect(setContactType).not.toHaveBeenCalled();
    expect(setStatus).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it("does not send an actionless reply when the listing is reassigned to a human during planning", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    harness.crm.setContactState(PHONE, {
      contactType: "owner",
      status: "agreed",
      managerId: 2,
      managerIsAi: true,
      listings: [{ id: 101 } as never],
    });
    const sender = senderRecorder();
    harness.services.sender = sender;
    const readListings = harness.crm.getListingsByPhone.bind(harness.crm);
    let planningCompleted = false;
    const getListings = vi.spyOn(harness.crm, "getListingsByPhone").mockImplementation(async (phone) => {
      const listings = await readListings(phone);
      return planningCompleted
        ? listings.map((listing) => ({ ...listing, assigned_manager_is_ai: false }))
        : listings;
    });
    harness.llm.responder = () => {
      planningCompleted = true;
      return JSON.stringify({ reply: "Спасибо, я уточню.", actions: [], stopConversation: false });
    };

    await enqueueOwnerMessage(harness, "Квартира свободна");
    const outcome = await runScheduled(harness);

    expect(outcome.status).toBe("skipped");
    expect(getListings).toHaveBeenCalledTimes(2);
    expect(harness.llm.calls).toHaveLength(1);
    expect(sender.calls).toHaveLength(0);
  });

  it("does not write or send when the selected second listing is reassigned to a human", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    harness.crm.setContactState(PHONE, {
      contactType: "owner",
      status: "agreed",
      managerId: 2,
      managerIsAi: true,
      listings: [{ id: 101 } as never, { id: 102 } as never],
    });
    const sender = senderRecorder();
    harness.services.sender = sender;
    const readListings = harness.crm.getListingsByPhone.bind(harness.crm);
    let planningCompleted = false;
    const getListings = vi.spyOn(harness.crm, "getListingsByPhone").mockImplementation(async (phone) => {
      const listings = await readListings(phone);
      return planningCompleted
        ? listings.map((listing) => String(listing.id) === "102"
          ? { ...listing, assigned_manager_is_ai: false }
          : listing)
        : listings;
    });
    const updateRental = vi.spyOn(harness.crm, "updateRentalTerms");
    harness.llm.responder = () => {
      planningCompleted = true;
      return JSON.stringify({
        reply: "Записал новую цену.",
        actions: [{ type: "update_rental_terms", listingId: 102, data: { price: 950 } }],
        selectedListingId: 102,
        stopConversation: false,
      });
    };

    await enqueueOwnerMessage(harness, "Для второй квартиры цена 950 долларов");
    const outcome = await runScheduled(harness);

    expect(outcome.status).toBe("skipped");
    expect(getListings).toHaveBeenCalledTimes(2);
    expect(harness.llm.calls).toHaveLength(1);
    expect(updateRental).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
  });

  it("quarantines an invalid qualified proposal after one correction without CRM writes or sends", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "1" });
    harness.crm.setContactState(PHONE, { status: "agreed", contactType: "potential_owner" });
    const sender = senderRecorder();
    harness.services.sender = sender;
    const setStatus = vi.spyOn(harness.crm, "setStatus");
    const setContactType = vi.spyOn(harness.crm, "setContactType");
    const updateRental = vi.spyOn(harness.crm, "updateRentalTerms");
    const invalid = qualifiedPlan();
    harness.llm.responder = () => invalid;

    const key = await enqueueOwnerMessage(harness);
    const outcome = await runScheduled(harness);

    expect(outcome.status).toBe("quarantined");
    expect(harness.llm.calls).toHaveLength(2);
    expect(setStatus).not.toHaveBeenCalled();
    expect(setContactType).not.toHaveBeenCalled();
    expect(updateRental).not.toHaveBeenCalled();
    expect(sender.calls).toHaveLength(0);
    const active = await harness.store.getActiveBatch(key);
    expect(active?.agentCheckpoint).toBeUndefined();
    expect(active?.quarantineReason).toContain("manager review required");
  });
});
