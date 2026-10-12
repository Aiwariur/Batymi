import { randomUUID } from "crypto";
import { describe, expect, it } from "vitest";
import Redis from "ioredis";
import { InboundBufferFullError } from "../../src/buffer/conversation-store";
import { activeBatchKey, activeBatchMessagesKey, debounceKey, pendingKey, seenKey } from "../../src/buffer/keys";
import { RedisConversationStore } from "../../src/buffer/redis-store";
import { NormalizedMessage } from "../../src/types";

const redisUrl = process.env.TEST_REDIS_URL;

function setup(prefix: string) {
  const instanceId = `stage7-${prefix}`;
  const chatId = `${prefix}@c.us`;
  const key = `${instanceId}:${chatId}`;
  const redis = new Redis(redisUrl!, { lazyConnect: true, maxRetriesPerRequest: 1 });
  const store = new RedisConversationStore(redis);
  const ids: string[] = [];
  const makeInput = (idMessage: string): Parameters<RedisConversationStore["acceptInbound"]>[0] => {
    ids.push(idMessage);
    const message: NormalizedMessage = {
      instanceId, idMessage, chatId, senderPhone: prefix,
      type: "audio", text: "", audio: { data: "T2dnUw==", mimetype: "audio/ogg; codecs=opus" },
      timestamp: 1_791_705_600, rawType: "ptt",
    };
    return {
      instanceId, idMessage, conversationKey: key, message,
      token: `token-${idMessage}`, idempotencyTtlSeconds: 600,
      debounceTtlMs: 60_000,
    };
  };
  const cleanup = async () => {
    await redis.del(
      pendingKey(key), activeBatchKey(key), activeBatchMessagesKey(key), debounceKey(key),
      ...ids.map(id => seenKey(instanceId, id)),
    );
    await redis.quit();
  };
  return { redis, store, key, instanceId, makeInput, cleanup };
}

describe.skipIf(!redisUrl)("Redis inbound media byte limits", () => {
  it("admits only one concurrent message at the serialized byte cap; rejected IDs remain retryable", async () => {
    const t = setup(randomUUID().replaceAll("-", ""));
    await t.redis.connect();
    try {
      const first = t.makeInput("msg-00000001");
      const second = t.makeInput("msg-00000002");
      const cap = Buffer.byteLength(JSON.stringify(first.message));
      expect(Buffer.byteLength(JSON.stringify(second.message))).toBe(cap);
      first.maxPendingBytes = cap;
      second.maxPendingBytes = cap;

      const results = await Promise.allSettled([
        t.store.acceptInbound(first), t.store.acceptInbound(second),
      ]);
      const acceptedIndex = results.findIndex(result => result.status === "fulfilled" && result.value);
      const rejectedIndex = results.findIndex(result => result.status === "rejected");
      expect(acceptedIndex).toBeGreaterThanOrEqual(0);
      expect(rejectedIndex).toBeGreaterThanOrEqual(0);
      expect(results.filter(result => result.status === "fulfilled" && result.value)).toHaveLength(1);
      expect((results[rejectedIndex] as PromiseRejectedResult).reason).toBeInstanceOf(InboundBufferFullError);

      const admitted = acceptedIndex === 0 ? first : second;
      const refused = rejectedIndex === 0 ? first : second;
      // Dedup is checked atomically before capacity, so an existing ID is accepted as a duplicate.
      expect(await t.store.acceptInbound(admitted)).toBe(false);

      const drained = await t.store.drainPending(t.key);
      expect(drained.map(message => message.idMessage)).toEqual([admitted.idMessage]);
      // The refused ID was not marked seen by the failed admission and can be retried after room opens.
      expect(await t.store.acceptInbound(refused)).toBe(true);
      expect(await t.store.pendingCount(t.key)).toBe(1);
    } finally {
      await t.cleanup();
    }
  });

  it("bounds active and pending serialized bytes independently", async () => {
    const t = setup(randomUUID().replaceAll("-", ""));
    await t.redis.connect();
    try {
      const activeInput = t.makeInput("active-0001");
      const cap = Buffer.byteLength(JSON.stringify(activeInput.message));
      activeInput.maxPendingBytes = cap;
      expect(await t.store.acceptInbound(activeInput)).toBe(true);
      expect(await t.store.drainPending(t.key)).toHaveLength(1);

      const pendingInput = t.makeInput("pending-01");
      pendingInput.maxPendingBytes = cap;
      expect(await t.store.acceptInbound(pendingInput)).toBe(true);

      const activeRows = await t.redis.lrange(activeBatchMessagesKey(t.key), 0, -1);
      const pendingRows = await t.redis.lrange(pendingKey(t.key), 0, -1);
      const activeBytes = activeRows.reduce((total, row) => total + Buffer.byteLength(row), 0);
      const pendingBytes = pendingRows.reduce((total, row) => total + Buffer.byteLength(row), 0);
      expect(activeBytes).toBeLessThanOrEqual(cap);
      expect(pendingBytes).toBeLessThanOrEqual(cap);
      expect(activeRows).toHaveLength(1);
      expect(pendingRows).toHaveLength(1);

      const overflow = t.makeInput("pending-02");
      overflow.maxPendingBytes = cap;
      await expect(t.store.acceptInbound(overflow)).rejects.toBeInstanceOf(InboundBufferFullError);
      expect(await t.redis.llen(activeBatchMessagesKey(t.key))).toBe(1);
      expect(await t.redis.llen(pendingKey(t.key))).toBe(1);
    } finally {
      await t.cleanup();
    }
  });
});
