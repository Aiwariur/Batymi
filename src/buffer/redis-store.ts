import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { HistoryEntry, NormalizedMessage } from "../types";
import { AcquiredLock, ConversationStore } from "./conversation-store";
import { debounceKey, historyKey, lockKey, pendingKey, seenKey } from "./keys";

const RELEASE_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
else
  return 0
end
`;

const REFRESH_LOCK_SCRIPT = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('PEXPIRE', KEYS[1], ARGV[2])
else
  return 0
end
`;

const DRAIN_PENDING_SCRIPT = `
local values = redis.call('LRANGE', KEYS[1], 0, -1)
if #values > 0 then
  redis.call('DEL', KEYS[1])
end
return values
`;

export class RedisConversationStore implements ConversationStore {
  constructor(private readonly redis: Redis) {}

  async markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(seenKey(instanceId, idMessage), "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async pushPending(conversationKey: string, message: NormalizedMessage): Promise<void> {
    await this.redis.rpush(pendingKey(conversationKey), JSON.stringify(message));
  }

  async drainPending(conversationKey: string): Promise<NormalizedMessage[]> {
    const raw = (await this.redis.eval(
      DRAIN_PENDING_SCRIPT,
      1,
      pendingKey(conversationKey),
    )) as string[];
    return raw.map((item) => JSON.parse(item) as NormalizedMessage);
  }

  async pendingCount(conversationKey: string): Promise<number> {
    return this.redis.llen(pendingKey(conversationKey));
  }

  async setDebounce(conversationKey: string, token: string, ttlMs: number): Promise<void> {
    await this.redis.set(debounceKey(conversationKey), token, "PX", Math.max(1, Math.round(ttlMs)));
  }

  async getDebounce(conversationKey: string): Promise<string | null> {
    return this.redis.get(debounceKey(conversationKey));
  }

  async acquireLock(conversationKey: string, ttlMs: number): Promise<AcquiredLock | null> {
    const token = randomUUID();
    const result = await this.redis.set(
      lockKey(conversationKey),
      token,
      "PX",
      Math.max(1, Math.round(ttlMs)),
      "NX",
    );
    return result === "OK" ? { token } : null;
  }

  async releaseLock(conversationKey: string, token: string): Promise<void> {
    await this.redis.eval(RELEASE_LOCK_SCRIPT, 1, lockKey(conversationKey), token);
  }

  async refreshLock(conversationKey: string, token: string, ttlMs: number): Promise<boolean> {
    const result = (await this.redis.eval(
      REFRESH_LOCK_SCRIPT,
      1,
      lockKey(conversationKey),
      token,
      String(Math.max(1, Math.round(ttlMs))),
    )) as number;
    return result === 1;
  }

  async appendHistory(
    conversationKey: string,
    entry: HistoryEntry,
    maxEntries: number,
    ttlSeconds: number,
  ): Promise<void> {
    const key = historyKey(conversationKey);
    const pipeline = this.redis.multi();
    pipeline.rpush(key, JSON.stringify(entry));
    pipeline.ltrim(key, -maxEntries, -1);
    pipeline.expire(key, ttlSeconds);
    await pipeline.exec();
  }

  async getHistory(conversationKey: string, limit: number): Promise<HistoryEntry[]> {
    const raw = await this.redis.lrange(historyKey(conversationKey), -limit, -1);
    return raw.map((item) => JSON.parse(item) as HistoryEntry);
  }

  async close(): Promise<void> {
    // The redis connection is owned by the connection factory.
  }
}
