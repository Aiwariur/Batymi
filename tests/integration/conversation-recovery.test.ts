import { describe, expect, it } from "vitest";
import { recoverOrphanConversations } from "../../src/queue/conversation-recovery";
import { createHarness } from "../helpers/harness";

describe("orphan conversation recovery", () => {
  it("schedules a recent pending batch once and respects its debounce token", async () => {
    const h = createHarness();
    const message = h.makeMessage({ instanceId: "recovery-line", chatId: "995550001111@c.us", timestamp: Date.now() });
    const key = h.key(message.instanceId, message.chatId);
    await h.store.pushPending(key, message);

    const first = await recoverOrphanConversations(h.services);
    const second = await recoverOrphanConversations(h.services);

    expect(first).toMatchObject({ scheduled: 1, manualReview: 0 });
    expect(second.scheduled).toBe(0);
    expect(h.scheduler.jobs).toHaveLength(1);
  });

  it("moves old or untimestamped orphan messages to manual review without scheduling", async () => {
    const h = createHarness();
    const oldMessage = h.makeMessage({
      instanceId: "recovery-line",
      chatId: "995550002222@c.us",
      timestamp: Date.now() - 25 * 60 * 60 * 1000,
    });
    const key = h.key(oldMessage.instanceId, oldMessage.chatId);
    await h.store.pushPending(key, oldMessage);

    const summary = await recoverOrphanConversations(h.services);

    expect(summary.manualReview).toBe(1);
    expect(h.scheduler.jobs).toHaveLength(0);
    expect(await h.store.getManualHandoff(key)).toContain("older than 24 hours");
  });

  it("does not reschedule an ambiguous outbound intent", async () => {
    const h = createHarness();
    const message = h.makeMessage({ instanceId: "recovery-line", chatId: "995550003333@c.us" });
    const key = h.key(message.instanceId, message.chatId);
    await h.store.pushPending(key, message);
    await h.store.drainPending(key);
    const active = await h.store.getActiveBatch(key);
    await h.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: message.instanceId,
      chatId: message.chatId,
      message: "prepared reply",
    });
    const outbound = await h.store.claimOutboundIntent(key, `${key}:${active!.batchKey}`);
    await h.store.markOutboundAmbiguous(key, outbound!.intentId, "provider timeout");

    const summary = await recoverOrphanConversations(h.services);
    expect(summary.manualReview).toBe(1);
    expect(h.scheduler.jobs).toHaveLength(0);
  });

  it("persists bounded retry backoff on a safely recoverable active batch", async () => {
    const h = createHarness();
    const message = h.makeMessage({ instanceId: "recovery-line", chatId: "995550006666@c.us" });
    const key = h.key(message.instanceId, message.chatId);
    await h.store.pushPending(key, message);
    await h.store.drainPending(key);
    const active = await h.store.getActiveBatch(key);
    const lock = await h.store.acquireLock(key, 60_000);
    const retryNotBefore = Date.now() + 60_000;

    expect(await h.store.deferRecovery(key, active!.batchKey, retryNotBefore, lock!.token)).toBe(1);
    await h.store.releaseLock(key, lock!.token);
    const summary = await recoverOrphanConversations(h.services);
    const deferred = await h.store.getActiveBatch(key);

    expect(summary.scheduled).toBe(0);
    expect(summary.skipped).toBe(1);
    expect(deferred?.recoveryFailureCount).toBe(1);
    expect(deferred?.retryNotBefore).toBe(retryNotBefore);
  });

  it("finalizes a confirmed sent intent without replaying old pending messages", async () => {
    const h = createHarness();
    const fresh = h.makeMessage({ instanceId: "recovery-line", chatId: "995550007777@c.us" });
    const key = h.key(fresh.instanceId, fresh.chatId);
    await h.store.pushPending(key, fresh);
    await h.store.drainPending(key);
    const active = await h.store.getActiveBatch(key);
    const intentId = `${key}:${active!.batchKey}`;
    await h.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: fresh.instanceId,
      chatId: fresh.chatId,
      message: "already sent reply",
    });
    await h.store.claimOutboundIntent(key, intentId);
    await h.store.markOutboundSent(key, intentId, "provider-message-id");
    await h.store.pushPending(key, h.makeMessage({
      instanceId: fresh.instanceId,
      chatId: fresh.chatId,
      timestamp: Date.now() - 25 * 60 * 60 * 1000,
    }));

    const summary = await recoverOrphanConversations(h.services);

    expect(summary.scheduled).toBe(1);
    expect(summary.manualReview).toBe(0);
    expect(h.scheduler.jobs).toHaveLength(1);
  });
});
