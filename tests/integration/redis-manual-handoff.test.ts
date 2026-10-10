import { describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisConversationStore } from "../../src/buffer/redis-store";
import { manualHandoffKey } from "../../src/buffer/keys";
import { NormalizedMessage } from "../../src/types";

describe.skipIf(!process.env.OUTBOUND_REDIS_URL)("Redis persistent manual handoff (opt-in)", () => {
  it("fences the pause by batch and lock, survives a new store, and leaves later batches drainable", async () => {
    const redis = new Redis(process.env.OUTBOUND_REDIS_URL!);
    const store = new RedisConversationStore(redis);
    const key = `manual-handoff-test:${Date.now()}:${Math.random()}`;
    const message: NormalizedMessage = { instanceId: "test-instance", idMessage: "first", chatId: "test@c.us",
      senderPhone: "test", type: "text", text: "Are you ai?", timestamp: Date.now(), rawType: "textMessage" };
    let token: string | undefined;
    try {
      await store.pushPending(key, message);
      await store.drainPending(key);
      const batch = (await store.getActiveBatch(key))!;
      token = (await store.acquireLock(key, 60_000))!.token;
      await expect(store.handoffToManager(key, "wrong-batch", "identity", token)).rejects.toThrow(/active batch/);
      await expect(store.handoffToManager(key, batch.batchKey, "identity", "wrong-lock")).rejects.toThrow(/conversation lock/);
      expect(await store.getManualHandoff(key)).toBeNull();
      await store.handoffToManager(key, batch.batchKey, "identity", token);
      expect(await store.getActiveBatch(key)).toBeNull();
      const recovered = new RedisConversationStore(redis);
      expect(await recovered.getManualHandoff(key)).toBe("identity");
      expect(await redis.ttl(manualHandoffKey(key))).toBe(-1);
      await recovered.pushPending(key, { ...message, idMessage: "second", text: "Hello?" });
      expect(await recovered.drainPending(key)).toHaveLength(1);
      await recovered.ackBatch(key);
      expect(await recovered.pendingCount(key)).toBe(0);
      expect(await recovered.getManualHandoff(key)).toBe("identity");
    } finally {
      await store.ackBatch(key);
      await redis.del(manualHandoffKey(key), `conversation:${key}:pending`);
      if (token) await store.releaseLock(key, token);
      await redis.quit();
    }
  });
});
