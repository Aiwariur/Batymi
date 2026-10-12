import { timingSafeEqual } from "crypto";
import { FastifyInstance } from "fastify";
import { Services } from "../services";
import { waApiWebhookSchema, WaApiWebhookPayload } from "../waapi/waapi.schemas";
import { resolveWaApiChat } from "../waapi/lid-resolver";
import { normalizeWaApiWebhook, isWaApiLid, isWaApiPhone } from "./waapi.normalizer";
import { ingestMessage } from "../buffer/message-buffer";
import { prepareWaApiMedia } from "../crm/webhook-proxy";
import { AudioInputError } from "../transcription/transcription.service";

/** Called by the durable forwarding worker after CRM receipt, also by the mock harness. */
export async function ingestWaApiPayload(instanceId: string, payload: WaApiWebhookPayload, services: Services) {
  const m = payload.data.message;
  if (payload.event !== "message" || !m || m.fromMe || m.isGroupMsg || m.isStatus ||
      !["chat", "image", "audio", "ptt", "document", "video"].includes(m.type) ||
      !(isWaApiPhone(m.from) || isWaApiLid(m.from)))
    return { ok: true, ignored: true, reason: "not an inbound user message" };
  const chatId = await resolveWaApiChat(services.config, instanceId, m.from);
  if (!chatId) throw Error("WaAPI LID is unresolved");
  const normalized = normalizeWaApiWebhook(instanceId, payload, chatId);
  if (!normalized) return { ok: true, ignored: true, reason: "unsupported message" };
  const result = await ingestMessage(normalized, services);
  return { ok: true, ...(result.duplicate ? { ignored: true } : {}), buffered: result.buffered, reason: result.reason };
}

export function registerWaApiRoutes(app: FastifyInstance, services: Services): void {
  app.post("/webhooks/waapi/:instanceId/:secret", async (request, reply) => {
    const { instanceId, secret } = request.params as { instanceId: string; secret: string };
    let instance;
    try { instance = services.instanceRegistry ? await services.instanceRegistry.resolve(instanceId)
      : services.config.instances.find(i => i.id === instanceId); }
    catch { return reply.code(503).send({ ok: false, error: "CRM instance registry unavailable" }); }
    const expected = Buffer.from(instance?.webhookSecret || ""); const received = Buffer.from(secret);
    if (!instance || instance.provider !== "waapi" || !expected.length || received.length !== expected.length || !timingSafeEqual(received, expected))
      return reply.code(401).send({ ok: false, error: "unauthorized webhook" });
    const parsed = waApiWebhookSchema.safeParse(request.body);
    if (!parsed.success || parsed.data.instanceId !== instanceId)
      return reply.code(400).send({ ok: false, error: "invalid WaAPI payload or instance" });
    try {
      const boundedPayload = prepareWaApiMedia(parsed.data, services.config.audioMaxBytes);
      // Real ingress only acknowledges a durable job. That job owns both CRM delivery
      // and inbound buffering, so an ingestion crash does not rely on provider retries.
      await services.webhookProxy.forward(instanceId, boundedPayload);
      if (services.webhookProxy.handlesWaApiIngress) return { ok: true, queued: true };
      return await ingestWaApiPayload(instanceId, waApiWebhookSchema.parse(boundedPayload), services);
    } catch (error) {
      if (error instanceof AudioInputError) return reply.code(error.message.includes("exceeds") ? 413 : 400).send({ ok: false, error: error.message });
      services.logger.warn({ instanceId }, "waapi.webhook.pending");
      return reply.code(503).send({ ok: false, error: "webhook processing unavailable" });
    }
  });
}
