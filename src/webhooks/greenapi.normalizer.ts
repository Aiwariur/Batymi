import { NormalizedMessage, MessageType } from "../types";
import { GreenApiWebhookPayload } from "../greenapi/greenapi.schemas";

const TYPE_MAP: Record<string, MessageType> = {
  textMessage: "text",
  extendedTextMessage: "text",
  audioMessage: "audio",
  imageMessage: "image",
  documentMessage: "document",
};

export function phoneFromChatId(chatId: string): string {
  const local = chatId.split("@")[0] ?? chatId;
  return local.replace(/[^\d]/g, "");
}

function mapType(rawType: string): MessageType {
  return TYPE_MAP[rawType] ?? "unsupported";
}

/**
 * Convert a raw GreenAPI payload into the internal NormalizedMessage shape.
 * Returns null when the payload is not a supported inbound user message.
 */
export function normalizeGreenApiWebhook(
  instanceId: string,
  payload: GreenApiWebhookPayload,
): NormalizedMessage | null {
  if (payload.typeWebhook !== "incomingMessageReceived") return null;

  const chatId = payload.senderData?.chatId;
  const idMessage = payload.idMessage;
  const messageData = payload.messageData;
  if (!chatId || !idMessage || !messageData) return null;

  const rawType = messageData.typeMessage ?? "unsupported";
  const type = mapType(rawType);
  const fileData = messageData.fileMessageData;

  const text =
    messageData.textMessageData?.textMessage ??
    messageData.extendedTextMessageData?.text ??
    fileData?.caption ??
    undefined;

  const fileUrl = fileData?.downloadUrl;

  const normalized: NormalizedMessage = {
    instanceId,
    idMessage,
    chatId,
    senderPhone: phoneFromChatId(chatId),
    type,
    timestamp: payload.timestamp ?? Date.now(),
    rawType,
  };

  if (type === "text" && text !== undefined) {
    normalized.text = text;
  }
  if (type === "audio") {
    normalized.fileUrl = fileUrl;
  }
  if (type === "image" || type === "document") {
    normalized.fileUrl = fileUrl;
    if (text !== undefined) normalized.text = text;
  }

  return normalized;
}
