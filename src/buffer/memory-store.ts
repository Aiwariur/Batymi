import { randomUUID } from "crypto";
import { HistoryEntry, NormalizedMessage } from "../types";
import { AcquiredLock, ConversationStore } from "./conversation-store";

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
  private pending = new Map<string, NormalizedMessage[]>();
  private debounce = new Map<string, ExpiringValue<string>>();
  private locks = new Map<string, ExpiringValue<string>>();
  private history = new Map<string, HistoryEntry[]>();

  async markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean> {
    const key = `${instanceId}:${idMessage}`;
    const existing = this.seen.get(key);
    if (existing !== undefined && existing > Date.now()) return false;
    this.seen.set(key, Date.now() + ttlSeconds * 1000);
    return true;
  }

  async pushPending(conversationKey: string, message: NormalizedMessage): Promise<void> {
    const list = this.pending.get(conversationKey) ?? [];
    list.push(message);
    this.pending.set(conversationKey, list);
  }

  async drainPending(conversationKey: string): Promise<NormalizedMessage[]> {
    const list = this.pending.get(conversationKey) ?? [];
    this.pending.delete(conversationKey);
    return list;
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
    this.pending.clear();
    this.debounce.clear();
    this.locks.clear();
    this.history.clear();
  }
}
