import { HistoryEntry, NormalizedMessage } from "../types";

export interface AcquiredLock {
  token: string;
}

/**
 * Small storage port used by the buffer / debounce / lock logic.
 *
 * There are exactly two implementations: RedisConversationStore (production)
 * and MemoryConversationStore (unit / integration tests). Keeping the surface
 * this small is intentional - it is not a generic repository layer.
 */
export interface ConversationStore {
  /** Returns true when this (instanceId, idMessage) pair was seen for the first time. */
  markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean>;

  /** Append a message to the conversation buffer, preserving order. */
  pushPending(conversationKey: string, message: NormalizedMessage): Promise<void>;

  /** Atomically take the current batch and clear the buffer. */
  drainPending(conversationKey: string): Promise<NormalizedMessage[]>;

  pendingCount(conversationKey: string): Promise<number>;

  setDebounce(conversationKey: string, token: string, ttlMs: number): Promise<void>;
  getDebounce(conversationKey: string): Promise<string | null>;

  acquireLock(conversationKey: string, ttlMs: number): Promise<AcquiredLock | null>;
  releaseLock(conversationKey: string, token: string): Promise<void>;
  refreshLock(conversationKey: string, token: string, ttlMs: number): Promise<boolean>;

  appendHistory(
    conversationKey: string,
    entry: HistoryEntry,
    maxEntries: number,
    ttlSeconds: number,
  ): Promise<void>;
  getHistory(conversationKey: string, limit: number): Promise<HistoryEntry[]>;

  close(): Promise<void>;
}
