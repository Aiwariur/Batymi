import { randomUUID } from "crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Services } from "../services";
import { greenApiWebhookSchema, GreenApiWebhookPayload } from "../greenapi/greenapi.schemas";
import { normalizeGreenApiWebhook } from "./greenapi.normalizer";
import { ingestMessage } from "../buffer/message-buffer";

const simulateSchema = z.object({
  instanceId: z.string().min(1),
  chatId: z.string().min(1),
  text: z.string().min(1),
  idMessage: z.string().optional(),
});

export function buildSimulatedPayload(input: {
  instanceId: string;
  chatId: string;
  text: string;
  idMessage: string;
}): GreenApiWebhookPayload {
  const numericId = Number(input.instanceId);
  return {
    typeWebhook: "incomingMessageReceived",
    idMessage: input.idMessage,
    timestamp: Math.floor(Date.now() / 1000),
    instanceData: {
      idInstance: Number.isFinite(numericId) ? numericId : input.instanceId,
      typeInstance: "whatsapp",
    },
    senderData: {
      chatId: input.chatId,
      chatName: "Simulated contact",
      sender: input.chatId,
      senderName: "Simulated contact",
    },
    messageData: {
      typeMessage: "textMessage",
      textMessageData: { textMessage: input.text },
    },
  };
}

export function registerGreenApiRoutes(app: FastifyInstance, services: Services): void {
  app.post("/webhooks/greenapi/:instanceId", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };

    const instance = services.config.instances.find((i) => i.id === instanceId);
    if (!instance) {
      reply.code(404);
      return { ok: false, error: "unknown GreenAPI instance" };
    }

    // Прозрачный прокси: каждый сырой вебхук уходит в CRM (входящие,
    // delivery-статусы), чтобы interactions/диалоги/воронка оставались
    // полными. Ack GreenAPI не блокируется.
    services.webhookProxy.forward(instanceId, request.body);

    const parsed = greenApiWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid GreenAPI payload" };
    }

    const normalized = normalizeGreenApiWebhook(instanceId, parsed.data);
    if (!normalized) {
      return { ok: true, ignored: true, reason: "not an inbound user message" };
    }

    const result = await ingestMessage(normalized, services);
    if (result.duplicate) {
      return { ok: true, ignored: true, reason: "duplicate" };
    }
    return { ok: true, buffered: result.buffered, reason: result.reason };
  });

  if (services.config.nodeEnv === "production") return;

  app.post("/debug/simulate-message", async (request, reply) => {
    const parsed = simulateSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid simulate payload" };
    }

    const instance = services.config.instances.find((i) => i.id === parsed.data.instanceId);
    if (!instance) {
      reply.code(404);
      return { ok: false, error: "unknown GreenAPI instance" };
    }

    const payload = buildSimulatedPayload({
      instanceId: parsed.data.instanceId,
      chatId: parsed.data.chatId,
      text: parsed.data.text,
      idMessage: parsed.data.idMessage ?? `sim-${randomUUID()}`,
    });
    const normalized = normalizeGreenApiWebhook(parsed.data.instanceId, payload);
    if (!normalized) {
      reply.code(400);
      return { ok: false, error: "could not normalize simulated message" };
    }

    const result = await ingestMessage(normalized, services);
    return { ok: true, ...result };
  });

  app.get("/debug/config", async () => {
    return {
      ok: true,
      nodeEnv: services.config.nodeEnv,
      mockExternals: services.config.mockExternals,
      messageDebounceMs: services.config.messageDebounceMs,
      instances: services.config.instances.map((instance) => instance.id),
    };
  });

  app.get("/debug/state", async () => {
    return { ok: true, ...services.debug.snapshot() };
  });

  app.post("/debug/reset", async () => {
    services.debug.reset();
    return { ok: true };
  });
}
