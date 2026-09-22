import { randomUUID } from "crypto";
import type Redis from "ioredis";
import { HistoryEntry, NormalizedMessage } from "../types";
import {
  ActiveBatch,
  AcquiredLock,
  ConversationStore,
  OutboundIntent,
} from "./conversation-store";
import {
  activeBatchKey,
  activeBatchMessagesKey,
  debounceKey,
  historyKey,
  ingressScheduledKey,
  lockKey,
  pendingKey,
  seenKey,
} from "./keys";

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
if redis.call('EXISTS', KEYS[2]) == 1 then
  return 0
end
if redis.call('EXISTS', KEYS[1]) == 1 then
  redis.call('RENAME', KEYS[1], KEYS[3])
  redis.call('SET', KEYS[2], ARGV[1])
  return 1
end
return 0
`;

const ACCEPT_INBOUND_SCRIPT = `
if redis.call('EXISTS', KEYS[1]) == 1 then return 0 end
redis.call('SET', KEYS[1], '1', 'EX', ARGV[1])
redis.call('RPUSH', KEYS[2], ARGV[2])
redis.call('SET', KEYS[3], ARGV[3], 'PX', ARGV[4])
return 1
`;

const UPDATE_ACTIVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local active = cjson.decode(raw)
if active.outbound == nil then return '' end
if active.outbound.intentId ~= ARGV[1] then return '' end
if ARGV[2] == 'claim' then
  if active.outbound.state ~= 'prepared' then return '' end
  active.outbound.state = 'sending'
elseif ARGV[2] == 'sent' then
  active.outbound.state = 'sent'
  if ARGV[3] ~= '' then active.outbound.idMessage = ARGV[3] end
elseif ARGV[2] == 'ambiguous' then
  active.outbound.state = 'ambiguous'
  active.outbound.error = string.sub(ARGV[3], 1, 500)
end
local outbound = cjson.encode(active.outbound)
redis.call('SET', KEYS[1], cjson.encode(active))
return outbound
`;

const PREPARE_OUTBOUND_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return '' end
local active = cjson.decode(raw)
if active.batchKey ~= ARGV[1] then return '' end
if active.outbound ~= nil then return cjson.encode(active.outbound) end
active.outbound = {
  intentId = ARGV[2],
  instanceId = ARGV[3],
  chatId = ARGV[4],
  message = ARGV[5],
  state = 'prepared'
}
redis.call('SET', KEYS[1], cjson.encode(active))
return cjson.encode(active.outbound)
`;

const ACK_ACTIVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local active = cjson.decode(raw)
if ARGV[1] ~= '' and active.batchKey ~= ARGV[1] then return 0 end
redis.call('DEL', KEYS[1], KEYS[2])
return 1
`;

const QUARANTINE_ACTIVE_SCRIPT = `
local raw = redis.call('GET', KEYS[1])
if not raw then return 0 end
local active = cjson.decode(raw)
if ARGV[2] ~= '' and active.batchKey ~= ARGV[2] then return 0 end
active.quarantineReason = string.sub(ARGV[1], 1, 500)
redis.call('SET', KEYS[1], cjson.encode(active))
return 1
`;

export class RedisConversationStore implements ConversationStore {
  constructor(private readonly redis: Redis) {}

  async acceptInbound(input: {
    instanceId: string;
    idMessage: string;
    conversationKey: string;
    message: NormalizedMessage;
    token: string;
    idempotencyTtlSeconds: number;
    debounceTtlMs: number;
  }): Promise<boolean> {
    const result = await this.redis.eval(
      ACCEPT_INBOUND_SCRIPT,
      3,
      seenKey(input.instanceId, input.idMessage),
      pendingKey(input.conversationKey),
      debounceKey(input.conversationKey),
      String(input.idempotencyTtlSeconds),
      JSON.stringify(input.message),
      input.token,
      String(Math.max(1, Math.round(input.debounceTtlMs))),
    );
    return Number(result) === 1;
  }

  async markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean> {
    const result = await this.redis.set(seenKey(instanceId, idMessage), "1", "EX", ttlSeconds, "NX");
    return result === "OK";
  }

  async markIngressScheduled(instanceId: string, idMessage: string, ttlSeconds: number): Promise<void> {
    await this.redis.set(ingressScheduledKey(instanceId, idMessage), "1", "EX", ttlSeconds);
  }

  async isIngressScheduled(instanceId: string, idMessage: string): Promise<boolean> {
    return (await this.redis.exists(ingressScheduledKey(instanceId, idMessage))) === 1;
  }

  async pushPending(conversationKey: string, message: NormalizedMessage): Promise<void> {
    // Legacy/test helper. Production ingress uses acceptInbound(), whose Lua
    // script claims idempotency and appends atomically.
    await this.redis.rpush(pendingKey(conversationKey), JSON.stringify(message));
  }

  async drainPending(conversationKey: string): Promise<NormalizedMessage[]> {
    await this.redis.eval(
      DRAIN_PENDING_SCRIPT,
      3,
      pendingKey(conversationKey),
      activeBatchKey(conversationKey),
      activeBatchMessagesKey(conversationKey),
      JSON.stringify({ batchKey: randomUUID() }),
    );
    const raw = await this.redis.lrange(activeBatchMessagesKey(conversationKey), 0, -1);
    if (raw.length === 0) return [];
    return raw.map((item) => JSON.parse(item) as NormalizedMessage);
  }

  async getActiveBatch(conversationKey: string): Promise<ActiveBatch | null> {
    const metadata = await this.redis.get(activeBatchKey(conversationKey));
    if (!metadata) return null;
    const parsed = JSON.parse(metadata) as Omit<ActiveBatch, "messages">;
    const raw = await this.redis.lrange(activeBatchMessagesKey(conversationKey), 0, -1);
    return {
      ...parsed,
      messages: raw.map((item) => JSON.parse(item) as NormalizedMessage),
    };
  }

  async ackBatch(conversationKey: string, batchKey?: string): Promise<void> {
    await this.redis.eval(
      ACK_ACTIVE_SCRIPT,
      2,
      activeBatchKey(conversationKey),
      activeBatchMessagesKey(conversationKey),
      batchKey ?? "",
    );
  }

  async quarantineBatch(conversationKey: string, reason: string, batchKey?: string): Promise<void> {
    await this.redis.eval(
      QUARANTINE_ACTIVE_SCRIPT,
      1,
      activeBatchKey(conversationKey),
      reason,
      batchKey ?? "",
    );
  }

  async prepareOutboundIntent(input: {
    conversationKey: string;
    batchKey: string;
    instanceId: string;
    chatId: string;
    message: string;
  }): Promise<OutboundIntent> {
    const raw = (await this.redis.eval(
      PREPARE_OUTBOUND_SCRIPT,
      1,
      activeBatchKey(input.conversationKey),
      input.batchKey,
      `${input.conversationKey}:${input.batchKey}`,
      input.instanceId,
      input.chatId,
      input.message,
    )) as string;
    if (!raw) throw new Error("active batch is missing or changed while preparing outbound intent");
    return JSON.parse(raw) as OutboundIntent;
  }

  async claimOutboundIntent(conversationKey: string, intentId: string): Promise<OutboundIntent | null> {
    const raw = (await this.redis.eval(
      UPDATE_ACTIVE_SCRIPT,
      1,
      activeBatchKey(conversationKey),
      intentId,
      "claim",
      "",
    )) as string;
    return raw ? (JSON.parse(raw) as OutboundIntent) : null;
  }

  async markOutboundSent(conversationKey: string, intentId: string, idMessage?: string): Promise<void> {
    const raw = (await this.redis.eval(
      UPDATE_ACTIVE_SCRIPT,
      1,
      activeBatchKey(conversationKey),
      intentId,
      "sent",
      idMessage ?? "",
    )) as string;
    if (!raw) throw new Error("outbound intent is missing");
  }

  async markOutboundAmbiguous(conversationKey: string, intentId: string, error: string): Promise<void> {
    const raw = (await this.redis.eval(
      UPDATE_ACTIVE_SCRIPT,
      1,
      activeBatchKey(conversationKey),
      intentId,
      "ambiguous",
      error,
    )) as string;
    if (!raw) throw new Error("outbound intent is missing");
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
