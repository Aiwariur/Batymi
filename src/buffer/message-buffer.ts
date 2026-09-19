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
  const isNew = await services.store.markSeen(
    message.instanceId,
    message.idMessage,
    services.config.idempotencyTtlSeconds,
  );
  if (!isNew) {
    return { accepted: false, duplicate: true, buffered: false, reason: "duplicate" };
  }

  if (message.type === "unsupported") {
    services.logger.info(
      { instanceId: message.instanceId, chatId: message.chatId, rawType: message.rawType },
      "message.unsupported",
    );
    return { accepted: true, duplicate: false, buffered: false, reason: "unsupported_type" };
  }

  const key = conversationKey(message.instanceId, message.chatId);
  await services.store.pushPending(key, message);

  const token = randomUUID();
  await services.store.setDebounce(key, token, debounceTtlMs(services.config.messageDebounceMs));
  await services.scheduler.schedule(key, token, services.config.messageDebounceMs);

  return { accepted: true, duplicate: false, buffered: true };
}
