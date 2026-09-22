import { describe, expect, it } from "vitest";
import Redis from "ioredis";
import { RedisConversationStore } from "../../src/buffer/redis-store";
import { NormalizedMessage } from "../../src/types";

const redisUrl = process.env.OUTBOUND_REDIS_URL;
const ingressRedisUrl = process.env.REDIS_TEST_URL;

describe.skipIf(!redisUrl)("Redis outbound claim safety (opt-in)", () => {
  it("permits only one concurrent claim", async () => {
    const redis = new Redis(redisUrl!);
    const store = new RedisConversationStore(redis);
    const key = `outbound-test:${Date.now()}:${Math.random()}`;
    const message: NormalizedMessage = {
      instanceId: "test-instance",
      idMessage: `msg-${Date.now()}`,
      chatId: "995555000000@c.us",
      senderPhone: "995555000000",
      type: "text",
      text: "test",
      timestamp: Date.now(),
      rawType: "textMessage",
    };
    try {
      await store.pushPending(key, message);
      const batch = await store.drainPending(key);
      const active = await store.getActiveBatch(key);
      const intent = await store.prepareOutboundIntent({
        conversationKey: key,
        batchKey: active!.batchKey,
        instanceId: message.instanceId,
        chatId: message.chatId,
        message: "one claim",
      });
      const claims = await Promise.all([
        store.claimOutboundIntent(key, intent.intentId),
        store.claimOutboundIntent(key, intent.intentId),
      ]);
      expect(batch).toHaveLength(1);
      expect(claims.filter(Boolean)).toHaveLength(1);
      expect(claims.filter((claim) => claim?.state === "sending")).toHaveLength(1);
    } finally {
      await store.ackBatch(key);
      await redis.quit();
    }
  });
});

describe.skipIf(!ingressRedisUrl)("Redis ingress atomicity (opt-in)", () => {
  it("claims once, preserves one pending message, and recovers an unmarked schedule", async () => {
    const redis = new Redis(ingressRedisUrl!);
    const store = new RedisConversationStore(redis);
    const suffix = `${Date.now()}:${Math.random()}`;
    const instanceId = `ingress-test-${suffix}`;
    const idMessage = `msg-${suffix}`;
    const conversationKey = `ingress-conversation-${suffix}`;
    const message: NormalizedMessage = {
      instanceId,
      idMessage,
      chatId: "995555000000@c.us",
      senderPhone: "995555000000",
      type: "text",
      text: "test",
      timestamp: Date.now(),
      rawType: "textMessage",
    };
    const tokens = ["token-a", "token-b"];
    try {
      const accepted = await Promise.all(
        tokens.map((token) =>
          store.acceptInbound({
            instanceId,
            idMessage,
            conversationKey,
            message,
            token,
            idempotencyTtlSeconds: 60,
            debounceTtlMs: 60_000,
          }),
        ),
      );
      expect(accepted.filter(Boolean)).toHaveLength(1);
      expect(await store.pendingCount(conversationKey)).toBe(1);
      expect(tokens).toContain(await store.getDebounce(conversationKey));
      expect(await store.isIngressScheduled(instanceId, idMessage)).toBe(false);

      // This is the recovery path used after a scheduler failure: the
      // duplicate does not append a second message and reuses the token.
      const duplicate = await store.acceptInbound({
        instanceId,
        idMessage,
        conversationKey,
        message,
        token: "token-retry",
        idempotencyTtlSeconds: 60,
        debounceTtlMs: 60_000,
      });
      expect(duplicate).toBe(false);
      expect(await store.pendingCount(conversationKey)).toBe(1);
      expect(await store.getDebounce(conversationKey)).toMatch(/^token-[ab]$/);
    } finally {
      await redis.del(
        `seen:${instanceId}:${idMessage}`,
        `ingress-scheduled:${instanceId}:${idMessage}`,
        `conversation:${conversationKey}:pending`,
        `conversation:${conversationKey}:debounce`,
      );
      await redis.quit();
    }
  });
});
