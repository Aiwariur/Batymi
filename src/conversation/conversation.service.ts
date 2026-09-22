import { randomUUID } from "crypto";
import { Listing, NormalizedMessage } from "../types";
import { Services } from "../services";
import { buildSystemPrompt, resolvePhase } from "../agent/system-prompt";
import { runAgent } from "../agent/agent";
import { executeActions } from "../agent/actions";
import { applyGates } from "../agent/gates";
import { appendHistory, getHistory } from "./history.service";
import { debounceTtlMs } from "../buffer/keys";
import { ActiveBatch, OutboundIntent } from "../buffer/conversation-store";

const MAX_MANUAL_RETRIES = 2;

export interface ConversationJobInput {
  conversationKey: string;
  token: string;
  retryCount?: number;
}

export interface ConversationJobMeta {
  attemptsMade: number;
  maxAttempts: number;
  jobId?: string;
}

export type RunStatus =
  | "processed"
  | "skipped"
  | "empty"
  | "rescheduled"
  | "terminal"
  | "quarantined"
  | "failed";

export interface RunOutcome {
  status: RunStatus;
  runId: string;
  executedActions?: string[];
  reply?: string;
  stopConversation?: boolean;
}

export function parseConversationKey(conversationKey: string): { instanceId: string; chatId: string } {
  const index = conversationKey.indexOf(":");
  if (index === -1) return { instanceId: conversationKey, chatId: "" };
  return {
    instanceId: conversationKey.slice(0, index),
    chatId: conversationKey.slice(index + 1),
  };
}

function outcome(status: RunStatus, runId: string, extra: Partial<RunOutcome> = {}): RunOutcome {
  return { status, runId, ...extra };
}

export function filterListingsByManager(
  listings: Listing[],
  instanceManagerId: number | undefined,
  allowedManagerIds: number[],
): Listing[] {
  if (instanceManagerId !== undefined) {
    return listings.filter((listing) => Number(listing.assigned_manager_id) === instanceManagerId);
  }
  return listings.filter((listing) => managerAllowedForAgent(listing, allowedManagerIds));
}

/**
 * Диалог нашего агента — тот, где ответственный контакт помечен в CRM как
 * AI-агент (Manager.is_ai → assigned_manager_is_ai). Флаг неизвестен (старая
 * CRM / менеджер не назначен) — легаси-режим по ALLOWED_MANAGER_IDS.
 */
function managerAllowedForAgent(listing: Listing, allowedManagerIds: number[]): boolean {
  if (listing.assigned_manager_is_ai === true) return true;
  if (listing.assigned_manager_is_ai === false) return false;
  if (allowedManagerIds.length > 0) {
    return allowedManagerIds.includes(Number(listing.assigned_manager_id));
  }
  return true;
}

export function isTerminalListing(listing: Listing, terminalStatuses: string[]): boolean {
  const status = (listing.crm_status ?? "").toLowerCase();
  if (terminalStatuses.includes(status)) return true;
  if ((listing.contact_type ?? "").toLowerCase() === "realtor") return true;
  return false;
}

async function resolveBatchText(
  batch: NormalizedMessage[],
  services: Services,
): Promise<string> {
  const parts: string[] = [];
  for (const message of batch) {
    if (message.type === "text" && message.text) {
      parts.push(message.text);
    } else if (message.type === "audio" && message.fileUrl) {
      const transcript = await services.transcription.transcribe(message.fileUrl);
      if (transcript) parts.push(transcript);
    } else if ((message.type === "image" || message.type === "document") && message.text) {
      parts.push(message.text);
    }
  }
  return parts.join("\n").trim();
}

export async function handleConversationJob(
  input: ConversationJobInput,
  meta: ConversationJobMeta,
  services: Services,
): Promise<RunOutcome> {
  const runId = randomUUID();
  const key = input.conversationKey;
  const { instanceId, chatId } = parseConversationKey(key);
  const log = services.logger.child({ runId, conversationKey: key, instanceId, chatId, jobId: meta.jobId });
  const startedAt = Date.now();
  const isRetry = meta.attemptsMade > 0;
  log.info("run.start");

  if (!isRetry) {
    const currentToken = await services.store.getDebounce(key);
    if (input.token && currentToken !== input.token) {
      log.info("debounce.stale.skip");
      return outcome("skipped", runId);
    }
  }

  const lock = await services.store.acquireLock(key, services.config.conversationLockTtlMs);
  if (!lock) {
    log.warn("lock.busy.reschedule");
    if (isRetry) throw new Error("conversation is locked by another worker");
    await services.store.setDebounce(key, input.token, debounceTtlMs(services.config.messageDebounceMs));
    await services.scheduler.schedule(key, input.token, 1000, input.retryCount ?? 0);
    return outcome("rescheduled", runId);
  }

  const refreshInterval = Math.max(1000, Math.floor(services.config.conversationLockTtlMs / 3));
  let lockLost = false;
  const refreshTimer = setInterval(() => {
    void services.store
      .refreshLock(key, lock.token, services.config.conversationLockTtlMs)
      .then((ok) => {
        if (!ok) lockLost = true;
      })
      .catch(() => {
        lockLost = true;
      });
  }, refreshInterval);

  let batch: NormalizedMessage[] = [];
  let activeBatch: ActiveBatch | null = null;
  let outboundIntent: OutboundIntent | null = null;
  let sendAttempted = false;
  let stage = "init";
  let failed = false;
  let quarantined = false;

  try {
    stage = "buffer.drain";
    batch = await services.store.drainPending(key);
    if (batch.length === 0) {
      log.info("buffer.empty");
      return outcome("empty", runId);
    }
    activeBatch = await services.store.getActiveBatch(key);
    if (!activeBatch) throw new Error("active batch disappeared after drain");
    if (activeBatch.quarantineReason) {
      quarantined = true;
      failed = true;
      log.error({ reason: activeBatch.quarantineReason }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }
    if (activeBatch.outbound && ["sending", "ambiguous"].includes(activeBatch.outbound.state)) {
      quarantined = true;
      failed = true;
      const reason = `outbound intent ${activeBatch.outbound.intentId} is ${activeBatch.outbound.state}; manual reconciliation required`;
      await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
      log.error({ reason }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }
    log.info({ messages: batch.length }, "buffer.drained");

    // A confirmed remote send must be finalized from the durable intent. Do
    // not rerun the LLM or CRM actions when a worker crashed after the send.
    if (activeBatch.outbound?.state === "sent") {
      stage = "outbound.history.recover";
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: activeBatch.outbound.message, ts: Date.now() },
        {
          maxMessages: services.config.conversationHistoryMaxMessages,
          ttlSeconds: services.config.conversationHistoryTtlSeconds,
        },
      );
      if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
        throw new Error("conversation lock lost while recovering sent outbound intent");
      }
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("processed", runId, { reply: activeBatch.outbound.message });
    }

    stage = "batch.resolve";
    const batchText = await resolveBatchText(batch, services);
    if (!batchText) {
      log.warn("batch.no_text");
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("empty", runId);
    }
    if (services.config.logMessageContent) {
      log.debug({ batchText }, "batch.content");
    }

    const instance = services.config.instances.find((i) => i.id === instanceId);
    const phone = batch[0].senderPhone;

    stage = "crm.load";
    const listings = await services.crm.getListingsByPhone(phone);
    log.info({ listingId: listings[0]?.id ?? null, count: listings.length }, "crm.loaded");

    const allowedListings = filterListingsByManager(
      listings,
      instance?.managerId,
      services.config.allowedManagerIds,
    );
    if (allowedListings.length === 0) {
      log.warn({ found: listings.length }, "crm.no_allowed_listings");
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("skipped", runId);
    }

    const primaryListing = allowedListings[0];
    const terminal = allowedListings.every((listing) =>
      isTerminalListing(listing, services.config.terminalCrmStatuses),
    );
    if (terminal) {
      stage = "terminal";
      log.info(
        { crmStatus: primaryListing.crm_status, contactType: primaryListing.contact_type },
        "conversation.terminal",
      );
      await appendHistory(
        services.store,
        key,
        { role: "user", content: batchText, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("terminal", runId);
    }

    const phase = resolvePhase(primaryListing.crm_status);
    log.info({ phase, crmStatus: primaryListing.crm_status }, "conversation.phase");

    stage = "llm";
    const history = await getHistory(services.store, key, {
      maxMessages: services.config.conversationHistoryMaxMessages,
      ttlSeconds: services.config.conversationHistoryTtlSeconds,
    });
    const systemPrompt = buildSystemPrompt({
      crm: { phone, contact: null, listings: allowedListings },
      listings: allowedListings,
      primaryListing,
      phase,
    });

    const { result } = await runAgent(services.llm, log, { systemPrompt, history, batchText });

    stage = "crm.update";
    if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
      throw new Error("conversation lock lost before CRM actions");
    }
    const gate = applyGates(result.actions, {
      listings: allowedListings,
      primaryListingId: primaryListing.id,
      phase,
    });
    for (const rejectedAction of gate.rejected) {
      log.warn(
        { action: rejectedAction.action.type, reason: rejectedAction.reason },
        "action.gate.rejected",
      );
    }
    const executed = await executeActions(gate.allowed, {
      crm: services.crm,
      logger: log,
      debug: services.debug,
      phone,
      primaryListingId: primaryListing.id,
    });

    await appendHistory(
      services.store,
      key,
      { role: "user", content: batchText, ts: Date.now() },
      { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
    );

    stage = "crm.reply";
    const reply = result.reply?.trim();
    if (reply) {
      if (services.config.logMessageContent) log.debug({ reply }, "crm.reply.content");
      stage = "outbound.intent";
      outboundIntent = await services.store.prepareOutboundIntent({
        conversationKey: key,
        batchKey: activeBatch.batchKey,
        instanceId,
        chatId,
        message: reply,
      });
      let sentResult: { idMessage?: string; mocked: boolean } | undefined;
      if (outboundIntent.state === "sent") {
        log.warn({ intentId: outboundIntent.intentId }, "crm.reply.already_sent");
      } else if (outboundIntent.state === "prepared") {
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
          throw new Error("conversation lock lost before outbound claim");
        }
        const claimed = await services.store.claimOutboundIntent(key, outboundIntent.intentId);
        if (!claimed || claimed.state !== "sending") {
          quarantined = true;
          failed = true;
          const reason = `outbound intent ${outboundIntent.intentId} could not be exclusively claimed; manual reconciliation required`;
          await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
          return outcome("quarantined", runId);
        }
        outboundIntent = claimed;
        sendAttempted = true;
        log.info({ intentId: outboundIntent.intentId }, "crm.reply.started");
        sentResult = await services.sender.sendMessage({
          instanceId: outboundIntent.instanceId,
          chatId: outboundIntent.chatId,
          message: outboundIntent.message,
        });
        stage = "outbound.persist";
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
          throw new Error("conversation lock lost after outbound response");
        }
        await services.store.markOutboundSent(key, outboundIntent.intentId, sentResult.idMessage);
        outboundIntent = { ...outboundIntent, state: "sent", idMessage: sentResult.idMessage };
        log.info({ intentId: outboundIntent.intentId }, "crm.reply.completed");
      } else if (outboundIntent.state === "sending" || outboundIntent.state === "ambiguous") {
        quarantined = true;
        failed = true;
        const reason = `outbound intent ${outboundIntent.intentId} is ${outboundIntent.state}; manual reconciliation required`;
        await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
        return outcome("quarantined", runId);
      }
      const sentReply = outboundIntent.message;
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: sentReply, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
    }

    stage = "batch.ack";
    if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
      throw new Error("conversation lock lost before batch acknowledgement");
    }
    await services.store.ackBatch(key, activeBatch.batchKey);
    log.info(
      { duration: Date.now() - startedAt, actions: executed.length, stopConversation: result.stopConversation },
      "run.completed",
    );
    return outcome("processed", runId, {
      executedActions: executed,
      reply,
      stopConversation: result.stopConversation,
    });
  } catch (error) {
    failed = true;
    const attempt = meta.attemptsMade + 1;
    const retryCount = input.retryCount ?? 0;
    log.error(
      {
        stage,
        attempt,
        maxAttempts: meta.maxAttempts,
        err: (error as Error).message,
      },
      "run.failed",
    );

    const currentActive = await services.store.getActiveBatch(key).catch(() => null);
    // A stale worker must never quarantine or mutate a newer batch that took
    // over after its lock expired. Only inspect the current store state when
    // its batch fence still matches the batch this worker claimed.
    const ownsActiveBatch = Boolean(activeBatch && currentActive?.batchKey === activeBatch.batchKey);
    const currentOutbound = ownsActiveBatch ? currentActive?.outbound ?? outboundIntent : outboundIntent;
    if (currentOutbound && (sendAttempted || currentOutbound.state === "sent")) {
      const reason = `outbound processing failed at ${stage}: ${(error as Error).message}; manual reconciliation required before resuming`;
      if (currentOutbound.state === "sending") {
        await services.store
          .markOutboundAmbiguous(key, currentOutbound.intentId, reason)
          .catch(() => undefined);
      }
      await services.store.quarantineBatch(key, reason, activeBatch?.batchKey).catch(() => undefined);
      quarantined = true;
      failed = true;
      log.error({ reason, intentId: currentOutbound.intentId }, "conversation.quarantined");
      return outcome("quarantined", runId);
    }

    const isFinalAttempt = attempt >= meta.maxAttempts;
    if (isFinalAttempt && retryCount < MAX_MANUAL_RETRIES) {
      const nextToken = randomUUID();
      const delay = 1000 * 2 ** retryCount;
      await services.store.setDebounce(key, nextToken, debounceTtlMs(services.config.messageDebounceMs));
      await services.scheduler.schedule(key, nextToken, delay, retryCount + 1);
      log.warn({ retryCount: retryCount + 1, delay }, "run.retry.scheduled");
      return outcome("rescheduled", runId);
    }

    if (isFinalAttempt) {
      log.error({ stage, retryCount }, "run.failed.permanent");
      return outcome("failed", runId);
    }

    throw error;
  } finally {
    clearInterval(refreshTimer);
    await services.store.releaseLock(key, lock.token).catch(() => undefined);

    if (!failed && !quarantined) {
      try {
        const remaining = await services.store.pendingCount(key);
        if (remaining > 0) {
          const nextToken = randomUUID();
          await services.store.setDebounce(key, nextToken, debounceTtlMs(services.config.messageDebounceMs));
          await services.scheduler.schedule(key, nextToken, services.config.messageDebounceMs, input.retryCount ?? 0);
        }
      } catch (error) {
        log.warn({ err: (error as Error).message }, "reschedule.after_run.failed");
      }
    }
  }
}
