import { describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisConversationStore } from "../../src/buffer/redis-store";
import { AgentCheckpoint } from "../../src/buffer/conversation-store";
import { NormalizedMessage } from "../../src/types";

const redisUrl = process.env.OUTBOUND_REDIS_URL;

describe.skipIf(!redisUrl)("Redis durable agent checkpoint (opt-in)", () => {
  it("recovers checkpoint progress under the active-batch fence without losing outbound state", async () => {
    const redis = new Redis(redisUrl!);
    const store = new RedisConversationStore(redis);
    const key = `checkpoint-test:${Date.now()}:${Math.random()}`;
    const message: NormalizedMessage = {
      instanceId: "test-instance",
      idMessage: `checkpoint-msg-${Date.now()}`,
      chatId: "995555000000@c.us",
      senderPhone: "995555000000",
      type: "text",
      text: "test",
      timestamp: Date.now(),
      rawType: "textMessage",
    };
    const checkpoint: AgentCheckpoint = {
      result: {
        reply: "Ready after action recovery",
        stopConversation: true,
        actions: [],
      },
      completedActions: 0,
      reply: "Ready after action recovery",
      finalized: true,
    };

    let lockToken: string | undefined;
    try {
      await store.pushPending(key, message);
      await store.drainPending(key);
      const batch = await store.getActiveBatch(key);
      expect(batch).not.toBeNull();
      const lock = await store.acquireLock(key, 60_000);
      expect(lock).not.toBeNull();
      lockToken = lock!.token;
      const intent = await store.prepareOutboundIntent({
        conversationKey: key,
        batchKey: batch!.batchKey,
        instanceId: message.instanceId,
        chatId: message.chatId,
        message: checkpoint.reply!,
      });

      await store.saveAgentCheckpoint(key, batch!.batchKey, checkpoint, lockToken);
      await store.claimOutboundIntent(key, intent.intentId);

      const recovered = await store.getActiveBatch(key);
      expect(recovered?.agentCheckpoint).toEqual(checkpoint);
      expect(Array.isArray(recovered?.agentCheckpoint?.result.actions)).toBe(true);
      expect(recovered?.outbound).toMatchObject({ intentId: intent.intentId, message: checkpoint.reply });
      expect(recovered?.outbound?.state).toBe("sending");

      const nextLock = await store.acquireLock(key, 60_000);
      expect(nextLock).toBeNull();
      await store.releaseLock(key, lockToken);
      const replacementLock = await store.acquireLock(key, 60_000);
      expect(replacementLock).not.toBeNull();
      await expect(
        store.saveAgentCheckpoint(key, batch!.batchKey, checkpoint, lockToken),
      ).rejects.toThrow(/conversation lock/);
      await store.releaseLock(key, replacementLock!.token);
      await expect(store.saveAgentCheckpoint(key, "stale-batch", checkpoint)).rejects.toThrow(/active batch/);
    } finally {
      await store.ackBatch(key);
      await redis.del(`conversation:${key}:pending`);
      if (lockToken) await store.releaseLock(key, lockToken);
      await redis.quit();
    }
  });

  it("rejects progress rollback for a still-active batch", async () => {
    const redis = new Redis(redisUrl!);
    const store = new RedisConversationStore(redis);
    const key = `checkpoint-rollback-test:${Date.now()}:${Math.random()}`;
    const message: NormalizedMessage = {
      instanceId: "test-instance",
      idMessage: `rollback-msg-${Date.now()}`,
      chatId: "995555000000@c.us",
      senderPhone: "995555000000",
      type: "text",
      text: "test",
      timestamp: Date.now(),
      rawType: "textMessage",
    };
    let lockToken: string | undefined;
    try {
      await store.pushPending(key, message);
      await store.drainPending(key);
      const batch = await store.getActiveBatch(key);
      const lock = await store.acquireLock(key, 60_000);
      expect(batch).not.toBeNull();
      expect(lock).not.toBeNull();
      lockToken = lock!.token;
      const initial: AgentCheckpoint = {
        result: { reply: "", stopConversation: false, actions: [{ type: "set_contact_type", contactType: "owner" }] },
        completedActions: 0,
      };
      const progressed: AgentCheckpoint = { ...initial, completedActions: 1 };
      await store.saveAgentCheckpoint(key, batch!.batchKey, progressed, lockToken);
      await expect(
        store.saveAgentCheckpoint(key, batch!.batchKey, initial, lockToken),
      ).rejects.toThrow(/backwards/);
    } finally {
      await store.ackBatch(key);
      await redis.del(`conversation:${key}:pending`);
      if (lockToken) await store.releaseLock(key, lockToken);
      await redis.quit();
    }
  });
});
