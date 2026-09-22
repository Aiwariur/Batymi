import { randomUUID } from "crypto";
import { HistoryEntry, NormalizedMessage } from "../types";
import {
  ActiveBatch,
  AcquiredLock,
  batchKeyForMessages,
  ConversationStore,
  OutboundIntent,
} from "./conversation-store";

interface ExpiringValue<T> {
  value: T;
  expiresAt: number;
}

/**
 * In-memory ConversationStore used by unit and integration tests.
 * Mirrors the semantics of RedisConversationStore (order, atomic drain, TTL,
 * owner-only lock release) without needing a running Redis.
 */
export class MemoryConversationStore implements ConversationStore {
  private seen = new Map<string, number>();
  private scheduled = new Map<string, number>();
  private pending = new Map<string, NormalizedMessage[]>();
  private debounce = new Map<string, ExpiringValue<string>>();
  private locks = new Map<string, ExpiringValue<string>>();
  private history = new Map<string, HistoryEntry[]>();
  private active = new Map<string, ActiveBatch>();

  async acceptInbound(input: {
    instanceId: string;
    idMessage: string;
    conversationKey: string;
    message: NormalizedMessage;
    token: string;
    idempotencyTtlSeconds: number;
    debounceTtlMs: number;
  }): Promise<boolean> {
    const isNew = await this.markSeen(input.instanceId, input.idMessage, input.idempotencyTtlSeconds);
    if (!isNew) return false;
    await this.pushPending(input.conversationKey, input.message);
    await this.setDebounce(input.conversationKey, input.token, input.debounceTtlMs);
    return true;
  }

  async markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean> {
    const key = `${instanceId}:${idMessage}`;
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > Date.now()) return false;
    this.seen.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  async markIngressScheduled(instanceId: string, idMessage: string, ttlSeconds: number): Promise<void> {
    this.scheduled.set(`${instanceId}:${idMessage}`, Date.now() + ttlSeconds * 1000);
  }

  async isIngressScheduled(instanceId: string, idMessage: string): Promise<boolean> {
    const key = `${instanceId}:${idMessage}`;
    const expiresAt = this.scheduled.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.scheduled.delete(key);
      return false;
    }
    return true;
  }

  async pushPending(conversationKey: string, message: NormalizedMessage): Promise<void> {
    const list = this.pending.get(conversationKey) ?? [];
    list.push(message);
    this.pending.set(conversationKey, list);
  }

  async drainPending(conversationKey: string): Promise<NormalizedMessage[]> {
    const existing = this.active.get(conversationKey);
    if (existing) return existing.messages.slice();
    const list = this.pending.get(conversationKey) ?? [];
    if (list.length === 0) return [];
    this.pending.delete(conversationKey);
    this.active.set(conversationKey, {
      batchKey: batchKeyForMessages(list),
      messages: list.slice(),
    });
    return list.slice();
  }

  async getActiveBatch(conversationKey: string): Promise<ActiveBatch | null> {
    const active = this.active.get(conversationKey);
    if (!active) return null;
    return {
      ...active,
      messages: active.messages.slice(),
      outbound: active.outbound ? { ...active.outbound } : undefined,
    };
  }

  async ackBatch(conversationKey: string, batchKey?: string): Promise<void> {
    const active = this.active.get(conversationKey);
    if (!active || (batchKey && active.batchKey !== batchKey)) return;
    this.active.delete(conversationKey);
  }

  async quarantineBatch(conversationKey: string, reason: string, batchKey?: string): Promise<void> {
    const active = this.active.get(conversationKey);
    if (active && (!batchKey || active.batchKey === batchKey)) active.quarantineReason = reason;
  }

  async prepareOutboundIntent(input: {
    conversationKey: string;
    batchKey: string;
    instanceId: string;
    chatId: string;
    message: string;
  }): Promise<OutboundIntent> {
    const active = this.active.get(input.conversationKey);
    if (!active || active.batchKey !== input.batchKey) {
      throw new Error("active batch is missing while preparing outbound intent");
    }
    if (!active.outbound) {
      active.outbound = {
        intentId: `${input.conversationKey}:${input.batchKey}`,
        instanceId: input.instanceId,
        chatId: input.chatId,
        message: input.message,
        state: "prepared",
      };
    }
    return { ...active.outbound };
  }

  async claimOutboundIntent(conversationKey: string, intentId: string): Promise<OutboundIntent | null> {
    const outbound = this.active.get(conversationKey)?.outbound;
    if (!outbound || outbound.intentId !== intentId) return null;
    if (outbound.state !== "prepared") return null;
    outbound.state = "sending";
    return { ...outbound };
  }

  async markOutboundSent(conversationKey: string, intentId: string, idMessage?: string): Promise<void> {
    const outbound = this.active.get(conversationKey)?.outbound;
    if (!outbound || outbound.intentId !== intentId) throw new Error("outbound intent is missing");
    outbound.state = "sent";
    outbound.idMessage = idMessage;
  }

  async markOutboundAmbiguous(conversationKey: string, intentId: string, error: string): Promise<void> {
    const outbound = this.active.get(conversationKey)?.outbound;
    if (!outbound || outbound.intentId !== intentId) throw new Error("outbound intent is missing");
    outbound.state = "ambiguous";
    outbound.error = error.slice(0, 500);
  }

  async pendingCount(conversationKey: string): Promise<number> {
    return (this.pending.get(conversationKey) ?? []).length;
  }

  async setDebounce(conversationKey: string, token: string, ttlMs: number): Promise<void> {
    this.debounce.set(conversationKey, { value: token, expiresAt: Date.now() + ttlMs });
  }

  async getDebounce(conversationKey: string): Promise<string | null> {
    const entry = this.debounce.get(conversationKey);
    if (!entry) return null;
    if (entry.expiresAt <= Date.now()) {
      this.debounce.delete(conversationKey);
      return null;
    }
    return entry.value;
  }

  async acquireLock(conversationKey: string, ttlMs: number): Promise<AcquiredLock | null> {
    const existing = this.locks.get(conversationKey);
    if (existing && existing.expiresAt > Date.now()) return null;
    const token = randomUUID();
    this.locks.set(conversationKey, { value: token, expiresAt: Date.now() + ttlMs });
    return { token };
  }

  async releaseLock(conversationKey: string, token: string): Promise<void> {
    const existing = this.locks.get(conversationKey);
    if (existing && existing.value === token) {
      this.locks.delete(conversationKey);
    }
  }

  async refreshLock(conversationKey: string, token: string, ttlMs: number): Promise<boolean> {
    const existing = this.locks.get(conversationKey);
    if (existing && existing.value === token && existing.expiresAt > Date.now()) {
      existing.expiresAt = Date.now() + ttlMs;
      return true;
    }
    return false;
  }

  async appendHistory(
    conversationKey: string,
    entry: HistoryEntry,
    maxEntries: number,
    _ttlSeconds: number,
  ): Promise<void> {
    const list = this.history.get(conversationKey) ?? [];
    list.push(entry);
    while (list.length > maxEntries) list.shift();
    this.history.set(conversationKey, list);
  }

  async getHistory(conversationKey: string, limit: number): Promise<HistoryEntry[]> {
    const list = this.history.get(conversationKey) ?? [];
    return list.slice(-limit);
  }

  async close(): Promise<void> {
    this.seen.clear();
    this.scheduled.clear();
    this.pending.clear();
    this.active.clear();
    this.debounce.clear();
    this.locks.clear();
    this.history.clear();
  }
}
