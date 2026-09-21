import { randomUUID } from "crypto";
import { Listing, NormalizedMessage } from "../types";
import { Services } from "../services";
import { buildSystemPrompt, resolvePhase } from "../agent/system-prompt";
import { runAgent } from "../agent/agent";
import { executeActions } from "../agent/actions";
import { applyGates } from "../agent/gates";
import { appendHistory, getHistory } from "./history.service";
import { debounceTtlMs } from "../buffer/keys";

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
  if (allowedManagerIds.length > 0) {
    return listings.filter((listing) =>
      allowedManagerIds.includes(Number(listing.assigned_manager_id)),
    );
  }
  return listings;
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
  const refreshTimer = setInterval(() => {
    void services.store
      .refreshLock(key, lock.token, services.config.conversationLockTtlMs)
      .catch(() => undefined);
  }, refreshInterval);

  let batch: NormalizedMessage[] = [];
  let stage = "init";
  let failed = false;

  try {
    stage = "buffer.drain";
    batch = await services.store.drainPending(key);
    if (batch.length === 0) {
      log.info("buffer.empty");
      return outcome("empty", runId);
    }
    log.info({ messages: batch.length }, "buffer.drained");

    stage = "batch.resolve";
    const batchText = await resolveBatchText(batch, services);
    if (!batchText) {
      log.warn("batch.no_text");
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
      log.info("crm.reply.started");
      await services.sender.sendMessage({ instanceId, chatId, message: reply });
      log.info("crm.reply.completed");
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: reply, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
    }

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

    if (batch.length > 0) {
      for (const message of batch) {
        await services.store.pushPending(key, message);
      }
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

    if (!failed) {
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
