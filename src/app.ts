import Fastify, { FastifyBaseLogger, FastifyInstance } from "fastify";
import { Services } from "./services";
import { registerGreenApiRoutes } from "./webhooks/greenapi.routes";

export interface RuntimeState {
  redisConnected: boolean;
  workerStarted: boolean;
}

export function buildApp(services: Services, runtime: RuntimeState): FastifyInstance {
  const app = Fastify({
    loggerInstance: services.logger as unknown as FastifyBaseLogger,
    bodyLimit: 5 * 1024 * 1024,
  });

  app.get("/health/live", async () => ({ ok: true }));

  app.get("/health/ready", async (_request, reply) => {
    const config = services.config;
    const missing: string[] = [];

    if (config.instances.length === 0) missing.push("GREENAPI instances");
    if (!config.mockCrm) {
      if (!config.crmBaseUrl) missing.push("CRM_BASE_URL");
      if (!config.crmApiKey) missing.push("CRM_API_KEY");
    }
    if (!config.mockLlm && !config.llmApiKey) missing.push("LLM_API_KEY");
    if ((config.isProduction || !config.mockGreenApi) && !config.webhookSecret) {
      missing.push("GREENAPI_WEBHOOK_SECRET");
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
      ...(missing.length ? { missing } : {}),
    };
  });

  registerGreenApiRoutes(app, services);

  return app;
}
