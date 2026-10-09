import { randomUUID } from "crypto";
import { Listing, NormalizedMessage } from "../types";
import { Services } from "../services";
import { buildSystemPrompt, resolvePhase, compactListing, PROMPT_VERSION } from "../agent/system-prompt";
import { runAgent, AgentOutputError } from "../agent/agent";
import { executeActions } from "../agent/actions";
import { applyGates } from "../agent/gates";

import { AgentResult } from "../agent/schemas";
import { appendHistory } from "./history.service";

import { debounceTtlMs } from "../buffer/keys";
import { ActiveBatch, OutboundIntent } from "../buffer/conversation-store";
import { assembleCrmHistory } from "./crm-history";
import { runTrace } from "../observability/run-trace";
import { planCooperation } from "./cooperation-agent";

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
  failureReason?: string;
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
  // Telegram-intake partners are approved agents, not acquisition targets.
  listings = listings.filter(listing => (listing.contact_type ?? "").toLowerCase() !== "partner");
  if (instanceManagerId !== undefined) {
    return listings.filter((listing) => listing.assigned_manager_is_ai !== false && Number(listing.assigned_manager_id) === instanceManagerId);
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
  if (status === "listing_removed" || status === "qualified" || status === "disagreed" || status === "realtor" || terminalStatuses.includes(status)) return true;
  if ((listing.contact_type ?? "").toLowerCase() === "realtor") return true;
  if (["rented", "withdrawn"].includes(listing.rental_terms?.availability_status ?? "")) return true;
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

export interface GuardAgentResponseInput {
  result: AgentResult;
  phase: ReturnType<typeof resolvePhase>;
  history: { role: "assistant" | "user"; content: string; ts?: number }[];
  batchText: string;
  listings: Listing[];
  primaryListing: Listing;
  contactListingCount?: number;
}
/** Only structural/action integrity. Never infer a fact or rewrite model text. */
export function finalizeAgentResponse(input: GuardAgentResponseInput) {
  const gate = applyGates(input.result.actions, {
    listings: input.listings, primaryListingId: input.primaryListing.id,
    phase: input.phase, selectedListingId: input.result.selectedListingId,
    contactListingCount: input.contactListingCount,
  });
  return { gate, reply: input.result.reply.trim(), stopConversation: input.result.stopConversation || gate.allowed.some(action =>
    action.type === "set_crm_status" && action.status === "realtor" ||
    action.type === "update_rental_terms" && action.data.availability_status === "rented") };
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
      return outcome("quarantined", runId, { failureReason: activeBatch.quarantineReason });
    }
    if (activeBatch.outbound && ["sending", "ambiguous"].includes(activeBatch.outbound.state)) {
      quarantined = true;
      failed = true;
      const reason = `outbound intent ${activeBatch.outbound.intentId} is ${activeBatch.outbound.state}; manual reconciliation required`;
      await services.store.quarantineBatch(key, reason, activeBatch.batchKey).catch(() => undefined);
      log.error({ reason }, "conversation.quarantined");
      return outcome("quarantined", runId, { failureReason: reason });
    }
    log.info({ messages: batch.length }, "buffer.drained");

    // Switching to handoff mode cancels already planned qualification replies.
    // Ambiguous sends were quarantined above and still require reconciliation.
    if (services.config.ownerDialogueMode === "cooperation_only" &&
        (activeBatch.outbound || activeBatch.agentCheckpoint) && activeBatch.agentCheckpoint?.mode !== "cooperation_only") {
      await services.store.ackBatch(key, activeBatch.batchKey);
      log.info("cooperation.old_plan_cancelled");
      return outcome("skipped", runId);
    }

    // A confirmed remote send must be finalized from the durable intent. Do
    // not rerun the LLM or CRM actions when a worker crashed after the send.
    if (activeBatch.outbound?.state === "sent") {
      stage = "outbound.history.recover";
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: activeBatch.outbound.message, ts: Date.now(), messageId: activeBatch.outbound.idMessage, sender: "agent" },
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
    const batchText = await resolveBatchText(
      services.config.ownerDialogueMode === "cooperation_only"
        ? batch.filter(message => message.type === "text" || message.type === "audio")
        : batch,
      services,
    );
    if (!batchText) {
      log.warn("batch.no_text");
      await services.store.ackBatch(key, activeBatch.batchKey);
      return outcome("empty", runId);
    }
    if (services.config.logMessageContent) {
      log.debug({ batchText }, "batch.content");
    }

    const instance = services.config.instances.find((i) => i.id === instanceId);
    if (!instance) throw new Error("unknown WhatsApp instance");
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
    // Resume an already validated batch even if its own actions made Contact terminal.
    // A new batch after that final answer has no checkpoint and stops here.
    if (!activeBatch.agentCheckpoint && allowedListings.every(listing =>
      isTerminalListing(listing, services.config.terminalCrmStatuses))) {
      log.info({ crmStatus: primaryListing.crm_status }, "conversation.terminal");
      for (const message of batch) await appendHistory(services.store, key,
        { role: "user", content: message.text ?? batchText, ts: message.timestamp, messageId: message.idMessage, sender: "owner" },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds });
      if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs)))
        throw new Error("conversation lock lost before terminal acknowledgement");
      await services.store.ackBatch(key, activeBatch.batchKey);
      await runTrace.record(runId, "terminal", { messageIds: batch.map(message => message.idMessage), listings: allowedListings.map(compactListing) });
      return outcome("terminal", runId);
    }

    stage = "crm.history";
    const interactions = await services.crm.getInteractions(phone, instanceId, 50);
    const local = await services.store.getHistory(key, services.config.conversationHistoryMaxMessages);
    const { history, managerTakeover } = assembleCrmHistory(interactions, local, batch, instanceId);
    await runTrace.record(runId, "context", {
      batchKey: activeBatch.batchKey, instanceId, messages: batch.map(message => ({ message_id: message.idMessage, text: message.text, timestamp: message.timestamp })),
      interactions, history, crm: allowedListings.map(compactListing), promptVersion: PROMPT_VERSION, model: services.config.llmModel,
    });
    if (managerTakeover) {
      log.info("conversation.manager_takeover");
      await services.store.ackBatch(key, activeBatch.batchKey);
      await runTrace.record(runId, "manager_takeover", {});
      return outcome("skipped", runId);
    }
    let checkpoint = activeBatch.agentCheckpoint;
    const executed: string[] = [];
    if (services.config.ownerDialogueMode === "cooperation_only") {
      stage = "cooperation.status";
      if (checkpoint?.mode === "cooperation_only" && !checkpoint.plannerVersion &&
          !checkpoint.reply && checkpoint.result.actions.length === 0 && !activeBatch.outbound) checkpoint = undefined;
      if (!checkpoint) {
        stage = "cooperation.llm";
        const result = await planCooperation(services.llm, { history, batchText, listings: allowedListings, interactions, instanceId,
          onRaw: raw => runTrace.record(runId, "cooperation.model", { raw }) });
        checkpoint = {
          mode: "cooperation_only", plannerVersion: "semantic_v1", completedActions: 0, reply: result.reply, finalized: true, result,
        };
        log.info({ actions: result.actions.length, selectedListingId: result.selectedListingId, replyPlanned: !!result.reply }, "cooperation.model.completed");
        await services.store.saveAgentCheckpoint(key, activeBatch.batchKey, checkpoint, lock.token);
      }
      const action = checkpoint.result.actions[0];
      if (action && checkpoint.completedActions === 0) {
        if (action.type !== "set_crm_status" || !["agreed", "disagreed", "realtor", "listing_removed"].includes(action.status))
          throw new Error("invalid cooperation checkpoint");
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs)))
          throw new Error("conversation lock lost before cooperation status");
        const latestListings = await services.crm.getListingsByPhone(phone);
        const latestHistory = await services.crm.getInteractions(phone, instanceId, 50);
        const target = filterListingsByManager(latestListings, instance.managerId, services.config.allowedManagerIds)
          .find(listing => String(listing.id) === String(action.listingId));
        if (!target || isTerminalListing(target, services.config.terminalCrmStatuses) && target.crm_status !== action.status ||
            assembleCrmHistory(latestHistory, [], batch, instanceId).managerTakeover) {
          await services.store.ackBatch(key, activeBatch.batchKey);
          return outcome("skipped", runId);
        }
        await services.crm.setStatus(target.id, action.status, { suppressTelegram: true, cooperationOnly: true });
        checkpoint.completedActions = 1;
        await services.store.saveAgentCheckpoint(key, activeBatch.batchKey, checkpoint, lock.token);
      }
      if (action) executed.push("set_crm_status");
      log.info({ decision: action?.type === "set_crm_status" ? action.status : checkpoint.reply ? "owner_reply" : "manual_review" }, "cooperation.completed");
    } else {
      const phase = resolvePhase(primaryListing.crm_status);
      const systemPrompt = buildSystemPrompt({ crm: { phone, contact: null, listings }, listings, primaryListing, phase, writableListingIds: allowedListings.map(listing => listing.id) });
      const benignRejections = new Set(["no_changes_vs_crm", "no_fields_to_write", "unchanged_contact_type", "status_already_agreed", "unchanged_crm_status"]);
      if (!checkpoint) {
        stage = "llm.plan";
        let plan = await runAgent(services.llm, log, { systemPrompt, history, batchText,
          onRaw: raw => runTrace.record(runId, "model.plan", { raw }) });
        let guarded = finalizeAgentResponse({ result: plan.result, phase, history, batchText, listings: allowedListings, primaryListing, contactListingCount: listings.length });
        let errors = guarded.gate.rejected.filter(item => !benignRejections.has(item.reason));
        if (errors.length) {
          await runTrace.record(runId, "actions.rejected", { errors });
          if (plan.repaired) throw new AgentOutputError("actions invalid after format repair", plan.raw);
          plan = await runAgent(services.llm, log, { systemPrompt, history, batchText, feedback: errors, previousRaw: plan.raw, allowRepair: false,
            onRaw: raw => runTrace.record(runId, "model.repair", { raw }) });
          guarded = finalizeAgentResponse({ result: plan.result, phase, history, batchText, listings: allowedListings, primaryListing, contactListingCount: listings.length });
          errors = guarded.gate.rejected.filter(item => !benignRejections.has(item.reason));
          if (errors.length) throw new Error("actions rejected after bounded repair: " + errors.map(item => item.reason).join(","));
        }
        await runTrace.record(runId, "actions.accepted", { allowed: guarded.gate.allowed, omittedNoops: guarded.gate.rejected });
        checkpoint = { result: { ...plan.result, actions: guarded.gate.allowed, stopConversation: guarded.stopConversation }, completedActions: 0 };
        await services.store.saveAgentCheckpoint(key, activeBatch.batchKey, checkpoint, lock.token);
      }

      stage = "crm.update";
      executed.push(...checkpoint.result.actions.slice(0, checkpoint.completedActions).map(action => action.type));
      let updatedListings = allowedListings;
      for (let index = checkpoint.completedActions; index < checkpoint.result.actions.length; index++) {
        if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs)))
          throw new Error("conversation lock lost before CRM action");
        // Re-read and compare before retrying a write whose response/checkpoint was lost.
        updatedListings = await services.crm.getListingsByPhone(phone);
        const latestHistory = await services.crm.getInteractions(phone, instanceId, 50);
        const action = checkpoint.result.actions[index];
        const targetId = action.type === "set_contact_type"
          ? checkpoint.result.selectedListingId ?? primaryListing.id
          : action.listingId ?? primaryListing.id;
        const writableNow = filterListingsByManager(updatedListings, instance.managerId, services.config.allowedManagerIds);
        const currentTarget = writableNow.find(listing => String(listing.id) === String(targetId));
        const alreadyAppliedTerminalAction = currentTarget && (
          action.type === "set_crm_status" && currentTarget.crm_status === action.status ||
          action.type === "set_contact_type" && currentTarget.contact_type === action.contactType
        );
        if (assembleCrmHistory(latestHistory, [], batch, instanceId).managerTakeover ||
            currentTarget && isTerminalListing(currentTarget, services.config.terminalCrmStatuses) && !alreadyAppliedTerminalAction ||
            !writableNow.some(listing => String(listing.id) === String(targetId))) {
          log.info("conversation.manager_takeover.before_action");
          await services.store.ackBatch(key, activeBatch.batchKey);
          return outcome("skipped", runId);
        }
        const gate = applyGates([action], {
          listings: writableNow, primaryListingId: primaryListing.id,
          phase: resolvePhase(updatedListings[0]?.crm_status), selectedListingId: checkpoint.result.selectedListingId,
          contactListingCount: updatedListings.length,
        });
        const errors = gate.rejected.filter(item => !benignRejections.has(item.reason));
        if (errors.length) throw new Error("CRM state changed before action: " + errors.map(item => item.reason).join(","));
        if (gate.allowed.length) {
          const names = await executeActions(gate.allowed, { crm: services.crm, logger: log, debug: services.debug, phone, primaryListingId: primaryListing.id });
          executed.push(...names);
        }
        updatedListings = await services.crm.getListingsByPhone(phone);
        await runTrace.record(runId, "crm.action_result", { index, action, success: true, noOp: !gate.allowed.length, crmAfter: updatedListings.map(compactListing) });
        checkpoint.completedActions = index + 1;
        await services.store.saveAgentCheckpoint(key, activeBatch.batchKey, checkpoint, lock.token);
      }
      if (!checkpoint.finalized) {
        let safeReply: string;
        let safeStopConversation = checkpoint.result.stopConversation;
        if (checkpoint.result.actions.length) {
          updatedListings = await services.crm.getListingsByPhone(phone);
          stage = "llm.final";
          const final = await runAgent(services.llm, log, { systemPrompt, history, batchText,
            executionResults: { results: checkpoint.result.actions.map(action => ({ action, success: true })), crmAfter: updatedListings.map(compactListing), proposedReply: checkpoint.result.reply },
            onRaw: raw => runTrace.record(runId, "model.final", { raw }) });
          safeReply = final.result.reply.trim();
          safeStopConversation = final.result.stopConversation || checkpoint.result.stopConversation;
        } else safeReply = checkpoint.result.reply.trim();
        if (!safeReply) throw new Error("model final reply is empty");
        checkpoint.reply = safeReply;
        checkpoint.result.stopConversation = safeStopConversation;
        checkpoint.finalized = true;
        await services.store.saveAgentCheckpoint(key, activeBatch.batchKey, checkpoint, lock.token);
      }
    }
    for (const message of batch) await appendHistory(services.store, key,
      { role: "user", content: message.text ?? batchText, ts: message.timestamp, messageId: message.idMessage, sender: "owner" },
      { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds });

    stage = "crm.reply";
    const reply = checkpoint.reply;
    if (reply) {
      const latestHistory = await services.crm.getInteractions(phone, instanceId, 50);
      const latestListings = await services.crm.getListingsByPhone(phone);
      const targetId = checkpoint.result.selectedListingId ?? primaryListing.id;
      const currentTarget = latestListings.find(listing => String(listing.id) === String(targetId));
      // A batch may send its own closing answer after persisting a terminal
      // action. A manager closing the contact while the LLM ran must win.
      const closedByThisBatch = currentTarget && checkpoint.result.actions.slice(0, checkpoint.completedActions).some(action =>
        action.type === "set_crm_status" && action.status === currentTarget.crm_status ||
        action.type === "set_contact_type" && action.contactType === "realtor" && currentTarget.contact_type === "realtor" ||
        action.type === "update_rental_terms" && action.data.availability_status === "rented" && currentTarget.rental_terms?.availability_status === "rented");
      if (assembleCrmHistory(latestHistory, [], batch, instanceId).managerTakeover ||
          currentTarget && isTerminalListing(currentTarget, services.config.terminalCrmStatuses) && !closedByThisBatch ||
          !filterListingsByManager(latestListings, instance.managerId, services.config.allowedManagerIds)
            .some(listing => String(listing.id) === String(targetId))) {
        log.info("conversation.manager_takeover.before_send");
        await services.store.ackBatch(key, activeBatch.batchKey);
        return outcome("skipped", runId);
      }
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
          return outcome("quarantined", runId, { failureReason: reason });
        }
        outboundIntent = claimed;
        sendAttempted = true;
        log.info({ intentId: outboundIntent.intentId }, "crm.reply.started");
        sentResult = await services.sender.sendMessage({
          instanceId: outboundIntent.instanceId,
          chatId: outboundIntent.chatId,
          message: outboundIntent.message,
        });
        await runTrace.record(runId, "outbound.result", { intentId: outboundIntent.intentId, batchKey: activeBatch.batchKey, instanceId, message: outboundIntent.message, idMessage: sentResult.idMessage });
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
        return outcome("quarantined", runId, { failureReason: reason });
      }
      const sentReply = outboundIntent.message;
      await appendHistory(
        services.store,
        key,
        { role: "assistant", content: sentReply, ts: Date.now(), messageId: outboundIntent.idMessage, sender: "agent" },
        { maxMessages: services.config.conversationHistoryMaxMessages, ttlSeconds: services.config.conversationHistoryTtlSeconds },
      );
    }

    stage = "batch.ack";
    if (lockLost || !(await services.store.refreshLock(key, lock.token, services.config.conversationLockTtlMs))) {
      throw new Error("conversation lock lost before batch acknowledgement");
    }
    await services.store.ackBatch(key, activeBatch.batchKey);
    log.info(
      { duration: Date.now() - startedAt, actions: executed.length, stopConversation: checkpoint.result.stopConversation },
      "run.completed",
    );
    return outcome("processed", runId, {
      executedActions: executed,
      reply,
      stopConversation: checkpoint.result.stopConversation,
    });
  } catch (error) {
    failed = true;
    await runTrace.record(runId, "failure", { stage, reason: (error as Error).message, batchKey: activeBatch?.batchKey }).catch(() => undefined);
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

    if (error instanceof AgentOutputError || (error as Error).message.startsWith("actions rejected after bounded repair")) {
      const reason = `model failure at ${stage}: ${(error as Error).message}; manager review required`;
      await services.store.quarantineBatch(key, reason, activeBatch?.batchKey);
      quarantined = true;
      return outcome("quarantined", runId, { failureReason: reason });
    }

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
      return outcome("quarantined", runId, { failureReason: reason });
    }

    const isFinalAttempt = attempt >= meta.maxAttempts;
    if (isFinalAttempt && retryCount < MAX_MANUAL_RETRIES) {
      const nextToken = randomUUID();
      const delay = 1000 * 2 ** retryCount;
      await services.store.setDebounce(key, nextToken, debounceTtlMs(services.config.messageDebounceMs));
      await services.scheduler.schedule(key, nextToken, delay, retryCount + 1);
      log.warn({ retryCount: retryCount + 1, delay }, "run.retry.scheduled");
      return outcome("rescheduled", runId, { failureReason: `${stage}: ${(error as Error).message}` });
    }

    if (isFinalAttempt) {
      log.error({ stage, retryCount }, "run.failed.permanent");
      return outcome("failed", runId, { failureReason: `${stage}: ${(error as Error).message}` });
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
