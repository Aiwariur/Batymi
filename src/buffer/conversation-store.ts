import { createHash } from "crypto";
import type { AgentResult } from "../agent/schemas";
import { HistoryEntry, NormalizedMessage } from "../types";

export interface AcquiredLock {
  token: string;
}

export type OutboundIntentState = "prepared" | "sending" | "sent" | "ambiguous";

export interface OutboundIntent {
  intentId: string;
  instanceId: string;
  chatId: string;
  message: string;
  state: OutboundIntentState;
  idMessage?: string;
  error?: string;
}

/** Durable progress for the currently claimed inbound batch. */
export interface AgentCheckpoint {
  mode?: "cooperation_only";
  plannerVersion?: "semantic_v1" | "semantic_v2";
  manualHandoffReason?: "identity" | "terms";
  result: AgentResult;
  /** Number of accepted CRM actions that completed successfully, in order. */
  completedActions: number;
  /** Final text to send once all actions have completed. */
  reply?: string;
  /** True once the final reply has been persisted for outbound recovery. */
  finalized?: boolean;
}

export function validateAgentCheckpoint(checkpoint: AgentCheckpoint): void {
  if (
    !Number.isInteger(checkpoint.completedActions) ||
    checkpoint.completedActions < 0 ||
    checkpoint.completedActions > checkpoint.result.actions.length
  ) {
    throw new Error("agent checkpoint completedActions is outside the action list");
  }
  if (checkpoint.finalized && typeof checkpoint.reply !== "string") {
    throw new Error("a finalized agent checkpoint must include the final reply");
  }
}

export interface ActiveBatch {
  batchKey: string;
  messages: NormalizedMessage[];
  quarantineReason?: string;
  outbound?: OutboundIntent;
  agentCheckpoint?: AgentCheckpoint;
}

/** Stable identity for the currently claimed inbound batch. */
export function batchKeyForMessages(messages: NormalizedMessage[]): string {
  return createHash("sha256")
    .update(
      messages
        .map((message) => `${message.instanceId}\u0000${message.idMessage}`)
        .join("\u0001"),
    )
    .digest("hex");
}

/**
 * Small storage port used by the buffer / debounce / lock logic.
 *
 * There are exactly two implementations: RedisConversationStore (production)
 * and MemoryConversationStore (unit / integration tests). Keeping the surface
 * this small is intentional - it is not a generic repository layer.
 */
export interface ConversationStore {
  /** Atomically claim a supported inbound message, append it, and set debounce. */
  acceptInbound(input: {
    instanceId: string;
    idMessage: string;
    conversationKey: string;
    message: NormalizedMessage;
    token: string;
    idempotencyTtlSeconds: number;
    debounceTtlMs: number;
  }): Promise<boolean>;

  /** Returns true when this (instanceId, idMessage) pair was seen for the first time. */
  markSeen(instanceId: string, idMessage: string, ttlSeconds: number): Promise<boolean>;

  /** Mark an accepted message after its conversation job is durably queued. */
  markIngressScheduled(instanceId: string, idMessage: string, ttlSeconds: number): Promise<void>;

  /** Whether this accepted message already has a durable conversation job. */
  isIngressScheduled(instanceId: string, idMessage: string): Promise<boolean>;

  /** Legacy/test append; production ingress uses acceptInbound atomically. */
  pushPending(conversationKey: string, message: NormalizedMessage): Promise<void>;

  /** Atomically take the current batch and clear the buffer. */
  drainPending(conversationKey: string): Promise<NormalizedMessage[]>;

  /** Return the durable in-flight batch, if one exists. */
  getActiveBatch(conversationKey: string): Promise<ActiveBatch | null>;

  /** Save model/action progress only while batchKey still fences the active batch. */
  saveAgentCheckpoint(
    conversationKey: string,
    batchKey: string,
    checkpoint: AgentCheckpoint,
    lockToken?: string,
  ): Promise<void>;

  /** Ack the in-flight batch after all CRM/history work is complete. */
  ackBatch(conversationKey: string, batchKey?: string): Promise<void>;

  /** Persistent silence for a conversation requiring a human answer. No TTL. */
  getManualHandoff(conversationKey: string): Promise<string | null>;
  /** Atomically pause and acknowledge only the current locked batch. */
  handoffToManager(conversationKey: string, batchKey: string, reason: string, lockToken: string): Promise<void>;

  /** Stop automatic processing while an outbound result needs reconciliation. */
  quarantineBatch(conversationKey: string, reason: string, batchKey?: string): Promise<void>;

  /** Create or reuse the one outbound intent belonging to the active batch. */
  prepareOutboundIntent(input: {
    conversationKey: string;
    batchKey: string;
    instanceId: string;
    chatId: string;
    message: string;
  }): Promise<OutboundIntent>;

  /** Atomically claim a prepared intent before making the remote request. */
  claimOutboundIntent(conversationKey: string, intentId: string): Promise<OutboundIntent | null>;

  markOutboundSent(
    conversationKey: string,
    intentId: string,
    idMessage?: string,
  ): Promise<void>;

  markOutboundAmbiguous(
    conversationKey: string,
    intentId: string,
    error: string,
  ): Promise<void>;

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
