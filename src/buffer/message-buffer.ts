import { randomUUID } from "crypto";
import { NormalizedMessage } from "../types";
import { Services } from "../services";
import { conversationKey, debounceTtlMs } from "./keys";

export interface IngestResult {
  accepted: boolean;
  duplicate: boolean;
  buffered: boolean;
  reason?: string;
}

/**
 * Single entry point for every inbound message (real webhook and debug
 * simulator both go through here). It only does cheap Redis work and schedules
 * a debounced job - it never waits for CRM, LLM, transcription or WhatsApp.
 */
export async function ingestMessage(
  message: NormalizedMessage,
  services: Services,
): Promise<IngestResult> {
  if (message.type === "unsupported") {
    const isNew = await services.store.markSeen(
      message.instanceId,
      message.idMessage,
      services.config.idempotencyTtlSeconds,
    );
    if (!isNew) return { accepted: false, duplicate: true, buffered: false, reason: "duplicate" };
    services.logger.info(
      { instanceId: message.instanceId, chatId: message.chatId, rawType: message.rawType },
      "message.unsupported",
    );
    return { accepted: true, duplicate: false, buffered: false, reason: "unsupported_type" };
  }

  const key = conversationKey(message.instanceId, message.chatId);
  const token = randomUUID();
  const isNew = await services.store.acceptInbound({
    instanceId: message.instanceId,
    idMessage: message.idMessage,
    conversationKey: key,
    message,
    token,
    idempotencyTtlSeconds: services.config.idempotencyTtlSeconds,
    debounceTtlMs: debounceTtlMs(services.config.messageDebounceMs),
  });
  if (!isNew) {
    if (await services.store.isIngressScheduled(message.instanceId, message.idMessage)) {
      return { accepted: false, duplicate: true, buffered: false, reason: "duplicate" };
    }

    // The seen marker can survive a crash or a queue failure after the
    // message was appended. Reuse the existing debounce token when possible,
    // otherwise derive a stable recovery token so concurrent retries map to
    // one BullMQ job instead of losing the pending message.
    const token =
      (await services.store.getDebounce(key)) ?? `retry-${message.instanceId}-${message.idMessage}`;
    await services.store.setDebounce(key, token, debounceTtlMs(services.config.messageDebounceMs));
    await services.scheduler.schedule(key, token, services.config.messageDebounceMs);
    await services.store.markIngressScheduled(
      message.instanceId,
      message.idMessage,
      services.config.idempotencyTtlSeconds,
    );
    return { accepted: false, duplicate: true, buffered: true, reason: "duplicate_recovered" };
  }
  await services.scheduler.schedule(key, token, services.config.messageDebounceMs);
  await services.store.markIngressScheduled(
    message.instanceId,
    message.idMessage,
    services.config.idempotencyTtlSeconds,
  );

  return { accepted: true, duplicate: false, buffered: true };
}
