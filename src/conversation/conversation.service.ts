import { randomUUID } from "crypto";
import { Flat, NormalizedMessage } from "../types";
import { Services } from "../services";
import { buildSystemPrompt } from "../agent/system-prompt";
import { runAgent } from "../agent/agent";
import { executeActions } from "../agent/actions";
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

export function filterFlatsByManager(
  flats: Flat[],
  instanceManagerId: number | undefined,
  allowedManagerIds: number[],
): Flat[] {
  if (instanceManagerId !== undefined) {
    return flats.filter((flat) => Number(flat.assigned_manager_id) === instanceManagerId);
  }
  if (allowedManagerIds.length > 0) {
    return flats.filter((flat) => allowedManagerIds.includes(Number(flat.assigned_manager_id)));
  }
  return flats;
}

export function isTerminalFlat(flat: Flat, terminalStatuses: string[]): boolean {
  const status = (flat.crm_status ?? "").toLowerCase();
  if (terminalStatuses.includes(status)) return true;
  if ((flat.contact_type ?? "").toLowerCase() === "realtor") return true;
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
    const flats = await services.crm.getFlatsByPhone(phone);
    log.info({ flatId: flats[0]?.id ?? null, count: flats.length }, "crm.loaded");

    const allowedFlats = filterFlatsByManager(flats, instance?.managerId, services.config.allowedManagerIds);
    if (allowedFlats.length === 0) {
      log.warn({ found: flats.length }, "crm.no_allowed_flats");
      return outcome("skipped", runId);
    }

    const primaryFlat = allowedFlats[0];
    const terminal = allowedFlats.every((flat) =>
      isTerminalFlat(flat, services.config.terminalCrmStatuses),
    );
    if (terminal) {
      stage = "terminal";
      log.info({ crmStatus: primaryFlat.crm_status, contactType: primaryFlat.contact_type }, "conversation.terminal");
      await appendHistory(
        services.store,
        key,
        { role: "user", content: batchText, ts: Date.now() },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
      return outcome("terminal", runId);
    }

    stage = "llm";
    const history = await getHistory(services.store, key, {
      maxMessages: services.config.conversationHistoryMaxMessages,
      ttlSeconds: services.config.conversationHistoryTtlSeconds,
    });
    const systemPrompt = buildSystemPrompt({
      crm: { phone, contact: null, flats: allowedFlats },
      flats: allowedFlats,
      primaryFlat,
      isTerminal: false,
    });

    const { result } = await runAgent(services.llm, log, { systemPrompt, history, batchText });

    stage = "crm.update";
    const executed = await executeActions(result.actions, {
      crm: services.crm,
      logger: log,
      debug: services.debug,
      phone,
      primaryFlatId: primaryFlat.id,
    });

    await appendHistory(
      services.store,
      key,
      { role: "user", content: batchText, ts: Date.now() },
      { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
    );

    stage = "greenapi.send";
    const reply = result.reply?.trim();
    if (reply) {
      if (services.config.logMessageContent) log.debug({ reply }, "greenapi.reply.content");
      log.info("greenapi.send.started");
      await services.greenApi.sendMessage({ instanceId, chatId, message: reply });
      log.info("greenapi.send.completed");
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
