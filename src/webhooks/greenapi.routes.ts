import { randomUUID, timingSafeEqual } from "crypto";
import { FastifyInstance } from "fastify";
import { z } from "zod";
import { Services } from "../services";
import { greenApiWebhookSchema, GreenApiWebhookPayload } from "../greenapi/greenapi.schemas";
import { isValidUserChatId, normalizeGreenApiWebhook } from "./greenapi.normalizer";
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

function instancePayloadMatchesRoute(instanceId: string, payload: GreenApiWebhookPayload): boolean {
  const payloadId = payload.instanceData?.idInstance;
  return payloadId === undefined || String(payloadId) === instanceId;
}

function expectedWebhookHeaderValue(services: Services): string {
  return services.config.webhookSecretHeader === "authorization"
    ? `Bearer ${services.config.webhookSecret}`
    : services.config.webhookSecret;
}

function isAuthorizedWebhook(request: { headers: Record<string, string | string[] | undefined> }, services: Services): boolean {
  const config = services.config;
  // Test/mock mode intentionally keeps the local harness convenient. Any
  // process that accepts real GreenAPI traffic must fail closed instead.
  if (!config.isProduction && config.mockGreenApi) return true;
  if (!config.webhookSecret) return false;

  const raw = request.headers[config.webhookSecretHeader.toLowerCase()];
  const received = Array.isArray(raw) ? raw[0] : raw;
  if (!received) return false;
  const expected = expectedWebhookHeaderValue(services);
  const receivedBuffer = Buffer.from(received);
  const expectedBuffer = Buffer.from(expected);
  return receivedBuffer.length === expectedBuffer.length && timingSafeEqual(receivedBuffer, expectedBuffer);
}

async function forwardOrFail(
  instanceId: string,
  payload: unknown,
  services: Services,
  reply: { code: (statusCode: number) => unknown },
): Promise<boolean> {
  try {
    await services.webhookProxy.forward(instanceId, payload);
    return true;
  } catch (error) {
    services.logger.error({ instanceId, err: (error as Error).message }, "webhook.forward.enqueue_failed");
    reply.code(503);
    return false;
  }
}

export function registerGreenApiRoutes(app: FastifyInstance, services: Services): void {
  app.post("/webhooks/greenapi/:instanceId", async (request, reply) => {
    const { instanceId } = request.params as { instanceId: string };

    if (!isAuthorizedWebhook(request, services)) {
      reply.code(401);
      return { ok: false, error: "unauthorized webhook" };
    }

    const instance = services.config.instances.find((i) => i.id === instanceId);
    if (!instance) {
      reply.code(404);
      return { ok: false, error: "unknown GreenAPI instance" };
    }

    const parsed = greenApiWebhookSchema.safeParse(request.body);
    if (!parsed.success) {
      reply.code(400);
      return { ok: false, error: "invalid GreenAPI payload" };
    }
    if (!instancePayloadMatchesRoute(instanceId, parsed.data)) {
      reply.code(400);
      return { ok: false, error: "GreenAPI instance mismatch" };
    }

    if (parsed.data.typeWebhook === "incomingMessageReceived") {
      const chatId = parsed.data.senderData?.chatId;
      if (!chatId || !isValidUserChatId(chatId)) {
        reply.code(400);
        return { ok: false, error: "invalid user chat id" };
      }

      const normalized = normalizeGreenApiWebhook(instanceId, parsed.data);
      if (!normalized) {
        reply.code(400);
        return { ok: false, error: "invalid inbound GreenAPI payload" };
      }

      // Durable proxy acceptance comes first. If buffer/scheduling fails, a
      // GreenAPI retry can still ingest the message; the deterministic proxy
      // id makes that retry safe even when CRM already received the event.
      if (!(await forwardOrFail(instanceId, parsed.data, services, reply))) {
        return { ok: false, error: "webhook forwarding unavailable" };
      }
      let result: Awaited<ReturnType<typeof ingestMessage>>;
      try {
        result = await ingestMessage(normalized, services);
      } catch (error) {
        services.logger.error({ instanceId, err: (error as Error).message }, "webhook.ingest_failed");
        reply.code(503);
        return { ok: false, error: "webhook buffering unavailable" };
      }
      if (result.duplicate) {
        return { ok: true, ignored: true, reason: "duplicate" };
      }
      return { ok: true, buffered: result.buffered, reason: result.reason };
    }

    if (!(await forwardOrFail(instanceId, parsed.data, services, reply))) {
      return { ok: false, error: "webhook forwarding unavailable" };
    }
    return { ok: true, ignored: true, reason: "not an inbound user message" };
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
