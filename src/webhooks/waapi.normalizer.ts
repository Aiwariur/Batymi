import { WaApiWebhookPayload } from "../waapi/waapi.schemas";
import { NormalizedMessage, MessageType } from "../types";

export const isWaApiPhone = (value: string): boolean => /^\d{1,15}@c\.us$/.test(value);
export const isWaApiLid = (value: string): boolean => /^[^@\s]+@lid$/.test(value);
const types: Record<string, MessageType> = { chat: "text", ptt: "audio", audio: "audio", image: "image", document: "document", video: "unsupported" };

export function normalizeWaApiWebhook(instanceId: string, payload: WaApiWebhookPayload, canonicalChatId: string): NormalizedMessage | null {
  const m = payload.data.message;
  if (payload.event !== "message" || !m || m.fromMe || m.isStatus || m.isGroupMsg || !types[m.type]) return null;
  if (!isWaApiPhone(canonicalChatId) || !(isWaApiPhone(m.from) || isWaApiLid(m.from))) return null;
  if (m.id.remote && !(isWaApiPhone(m.id.remote) || isWaApiLid(m.id.remote))) return null;
  const normalized: NormalizedMessage = { instanceId, idMessage: m.id._serialized, chatId: canonicalChatId,
    rawChatId: m.from, senderPhone: canonicalChatId.split("@")[0], type: types[m.type], rawType: m.type, timestamp: m.timestamp * 1000 };
  if (m.body !== undefined) normalized.text = m.body;
  const media = payload.data.media;
  if (normalized.type === "audio" && media?.data)
    normalized.audio = { data: media.data, mimetype: media.mimetype, ...(media.filename ? { filename: media.filename } : {}) };
  return normalized;
}
