import Fastify, { FastifyBaseLogger, FastifyInstance, LogController } from "fastify";
import { Services } from "./services";
import { registerGreenApiRoutes } from "./webhooks/greenapi.routes";
import { registerWaApiRoutes } from "./webhooks/waapi.routes";
import { RecoverySummary } from "./queue/conversation-recovery";

export interface RuntimeState {
  redisConnected: boolean;
  workerStarted: boolean;
  recovery?: RecoverySummary & { checkedAt: string };
}

export function buildApp(services: Services, runtime: RuntimeState): FastifyInstance {
  const app = Fastify({
    loggerInstance: services.logger as unknown as FastifyBaseLogger,
    bodyLimit: 5 * 1024 * 1024,
    // Fastify's default access log includes the URL; WaAPI keeps a secret in it.
    logController: new LogController({ disableRequestLogging: true }),
  });
  app.setNotFoundHandler((_request, reply) => reply.code(404).send({ ok: false, error: "route not found" }));

  app.get("/health/live", async () => ({ ok: true }));

  app.get("/health/ready", async (_request, reply) => {
    const config = services.config;
    const missing: string[] = [];

    if (config.instances.length === 0) missing.push("WhatsApp instances");
    if (!config.mockCrm) {
      if (!config.crmBaseUrl) missing.push("CRM_BASE_URL");
      if (!config.crmApiKey) missing.push("CRM_API_KEY");
    }
    if (!config.mockLlm && !config.llmApiKey) missing.push("LLM_API_KEY");
    if (config.instances.some(i => i.provider !== "waapi") && (config.isProduction || !config.mockGreenApi) && !config.webhookSecret) {
      missing.push("GREENAPI_WEBHOOK_SECRET");
    }
    if (config.instances.some(i => i.provider === "waapi")) {
      if (config.instances.some(i => i.provider === "waapi" && !i.webhookSecret)) missing.push("WaAPI line secret");
      if (!config.mockCrm && !config.waapiApiToken) missing.push("WAAPI_API_TOKEN");
    }

    const redis = runtime.redisConnected ? "ok" : "error";
    const worker = !config.workerEnabled || runtime.workerStarted ? "ok" : "error";
    const queue = runtime.redisConnected ? "ok" : "error";
    const ok = redis === "ok" && worker === "ok" && missing.length === 0;

    reply.code(ok ? 200 : 503);
    return {
      ok,
      redis,
      queue,
      worker,
      instances: config.instances.length,
      ownerDialogueMode: config.ownerDialogueMode,
      ...(runtime.recovery ? { recovery: runtime.recovery } : {}),
      ...(missing.length ? { missing } : {}),
    };
  });

  registerGreenApiRoutes(app, services);
  registerWaApiRoutes(app, services);

  return app;
}
