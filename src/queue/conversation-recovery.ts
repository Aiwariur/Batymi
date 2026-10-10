import { randomUUID } from "crypto";
import { Services } from "../services";
import { debounceTtlMs } from "../buffer/keys";
import { recoveryIssueId } from "../observability/agent-review";

const MAX_AUTO_RECOVERY_AGE_MS = 24 * 60 * 60 * 1000;
const RECOVERY_BACKOFF_MS = 60_000;

export interface RecoverySummary {
  scanned: number;
  scheduled: number;
  manualReview: number;
  skipped: number;
}

function asTimestamp(value: number | undefined): number | null {
  if (!Number.isFinite(value) || !value) return null;
  return value < 1_000_000_000_000 ? value * 1000 : value;
}

function oldestMessageAt(messages: Array<{ timestamp: number }>): number | null {
  const timestamps = messages.map((message) => asTimestamp(message.timestamp));
  if (timestamps.some((value) => value === null)) return null;
  return timestamps.length ? Math.min(...timestamps as number[]) : null;
}

export async function recoverOrphanConversations(services: Services): Promise<RecoverySummary> {
  const summary: RecoverySummary = { scanned: 0, scheduled: 0, manualReview: 0, skipped: 0 };
  const now = Date.now();
  for (const conversationKey of await services.store.listConversations()) {
    summary.scanned += 1;
    try {
      const manualHandoff = await services.store.getManualHandoff(conversationKey);
      if (manualHandoff) {
        const pausedBatch = await services.store.getActiveBatch(conversationKey);
        const [instanceId, chatId] = conversationKey.split(":");
        await services.crm.reportReview?.(chatId?.split("@")[0] ?? "", {
          issueId: pausedBatch?.batchKey ?? recoveryIssueId(conversationKey),
          reason: manualHandoff,
          state: "review_required",
          instanceId,
          messageId: pausedBatch?.messages[0]?.idMessage,
        }).catch((error) => services.logger.warn({ conversationKey, err: (error as Error).message }, "review.report.failed"));
        summary.manualReview += 1;
        continue;
      }
      if (await services.store.hasLock(conversationKey)) {
        summary.skipped += 1;
        continue;
      }

      const active = await services.store.getActiveBatch(conversationKey);
      const pendingCount = await services.store.pendingCount(conversationKey);
      if (!active && pendingCount === 0) {
        summary.skipped += 1;
        continue;
      }

      const currentToken = await services.store.getDebounce(conversationKey);
      if (currentToken) {
        summary.skipped += 1;
        continue;
      }

      const pendingMessages = await services.store.getPendingMessages(conversationKey);
      const messages = [...(active?.messages ?? []), ...pendingMessages];
      const messageTime = oldestMessageAt(messages);
      const createdAt = asTimestamp(active?.createdAt);
      const observedAt = messageTime ?? createdAt;
      const age = observedAt === null ? Number.POSITIVE_INFINITY : now - observedAt;
      const outbound = active?.outbound;
      const unsafeOutbound = outbound && ["sending", "ambiguous"].includes(outbound.state);
      const oldUnsentWork = age > MAX_AUTO_RECOVERY_AGE_MS && outbound?.state !== "sent";
      if (active?.quarantineReason || unsafeOutbound || oldUnsentWork) {
        const reason = active?.quarantineReason
          ?? (unsafeOutbound
            ? `outbound intent ${outbound!.intentId} is ${outbound!.state}; manual reconciliation required`
            : `queued owner message is older than 24 hours or has no reliable timestamp; manager review required`);
        if (active) await services.store.quarantineBatch(conversationKey, reason, active.batchKey);
        await services.store.markManualReview(conversationKey, reason);
        const [instanceId, chatId] = conversationKey.split(":");
        await services.crm.reportReview?.(chatId?.split("@")[0] ?? "", {
          issueId: active?.batchKey ?? recoveryIssueId(conversationKey),
          reason,
          state: "review_required",
          instanceId,
          messageId: messages[0]?.idMessage,
        }).catch((error) => services.logger.warn({ conversationKey, err: (error as Error).message }, "review.report.failed"));
        summary.manualReview += 1;
        continue;
      }

      if ((!observedAt || age > MAX_AUTO_RECOVERY_AGE_MS) && outbound?.state !== "sent") {
        summary.skipped += 1;
        continue;
      }
      if (active?.retryNotBefore && active.retryNotBefore > now) {
        summary.skipped += 1;
        continue;
      }

      const token = randomUUID();
      await services.store.setDebounce(conversationKey, token, debounceTtlMs(RECOVERY_BACKOFF_MS));
      await services.scheduler.schedule(conversationKey, token, RECOVERY_BACKOFF_MS);
      summary.scheduled += 1;
    } catch (error) {
      summary.skipped += 1;
      services.logger.warn({ conversationKey, err: (error as Error).message }, "conversation.recovery.failed");
    }
  }
  services.logger.info(summary, "conversation.recovery.complete");
  return summary;
}
