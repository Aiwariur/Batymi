import { describe, expect, it } from "vitest";
import Redis from "ioredis";
import { Queue } from "bullmq";
import { RedisConversationStore } from "../../src/buffer/redis-store";
import { BullConversationScheduler, jobIdFor } from "../../src/queue/conversation.queue";
import { recoverOrphanConversations } from "../../src/queue/conversation-recovery";
import { handleConversationJob } from "../../src/conversation/conversation.service";
import { createHarness } from "../helpers/harness";

const redisUrl = process.env.OUTBOUND_REDIS_URL;
const isolatedRedisUrl = redisUrl ? (() => {
  const parsed = new URL(redisUrl);
  parsed.pathname = "/14";
  return parsed.toString();
})() : undefined;

describe.skipIf(!redisUrl)("Redis/BullMQ queue recovery (opt-in)", () => {
  it("recovers a recent pending conversation into a real delayed job exactly once", async () => {
    const redis = new Redis(isolatedRedisUrl!);
    const queueRedis = new Redis(isolatedRedisUrl!);
    const queueName = `recovery-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const store = new RedisConversationStore(redis);
    const scheduler = new BullConversationScheduler(queueRedis, queueName);
    const queue = new Queue(queueName, { connection: queueRedis });
    const h = createHarness();
    h.services.store = store;
    h.services.scheduler = scheduler;
    const message = h.makeMessage({ instanceId: `recovery-${Date.now()}`, chatId: "995550004444@c.us" });
    const key = h.key(message.instanceId, message.chatId);

    try {
      await store.pushPending(key, message);
      const first = await recoverOrphanConversations(h.services);
      const second = await recoverOrphanConversations(h.services);
      const counts = await queue.getJobCounts("delayed");
      const jobs = await queue.getJobs(["delayed"]);

      expect(first.scheduled).toBe(1);
      expect(second.scheduled).toBe(0);
      expect(counts.delayed).toBe(1);
      expect(jobs[0]?.id).toContain("conv_");
    } finally {
      const keys: string[] = [];
      for await (const raw of redis.scanStream({ match: `conversation:${key}*` })) {
        keys.push(...(Array.isArray(raw) ? raw : [raw]) as string[]);
      }
      if (keys.length) await redis.del(...keys);
      await queue.obliterate({ force: true });
      await queue.close();
      await scheduler.close();
      await redis.quit();
      await queueRedis.quit();
    }
  });

  it("uses a distinct real BullMQ job id when a conversation lock is busy", async () => {
    const redis = new Redis(isolatedRedisUrl!);
    const queueRedis = new Redis(isolatedRedisUrl!);
    const queueName = `lock-contention-test-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
    const store = new RedisConversationStore(redis);
    const scheduler = new BullConversationScheduler(queueRedis, queueName);
    const queue = new Queue(queueName, { connection: queueRedis });
    const h = createHarness();
    h.services.store = store;
    h.services.scheduler = scheduler;
    h.services.config = { ...h.config, queueName };
    const message = h.makeMessage({ instanceId: `lock-${Date.now()}`, chatId: "995550005555@c.us" });
    const key = h.key(message.instanceId, message.chatId);
    const oldToken = "currently-running-job-token";
    const lock = await store.acquireLock(key, 60_000);

    try {
      await store.pushPending(key, message);
      await store.setDebounce(key, oldToken, 60_000);
      const result = await handleConversationJob(
        { conversationKey: key, token: oldToken },
        { attemptsMade: 0, maxAttempts: 3, jobId: jobIdFor(key, oldToken) },
        h.services,
      );
      const jobs = await queue.getJobs(["delayed"]);

      expect(result.status).toBe("rescheduled");
      expect(jobs).toHaveLength(1);
      expect(jobs[0].id).not.toBe(jobIdFor(key, oldToken));
      expect(await store.getDebounce(key)).not.toBe(oldToken);
    } finally {
      if (lock) await store.releaseLock(key, lock.token);
      const keys: string[] = [];
      for await (const raw of redis.scanStream({ match: `conversation:${key}*` })) {
        keys.push(...(Array.isArray(raw) ? raw : [raw]) as string[]);
      }
      if (keys.length) await redis.del(...keys);
      await queue.obliterate({ force: true });
      await queue.close();
      await scheduler.close();
      await redis.quit();
      await queueRedis.quit();
    }
  }, 20_000);
});
