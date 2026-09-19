import type IORedis from "ioredis";
import type { Worker } from "bullmq";
import { loadConfig } from "./config/env";
import { createLogger, Logger } from "./observability/logger";
import { InMemoryDebugRecorder } from "./observability/debug-recorder";
import { RedisConversationStore } from "./buffer/redis-store";
import { BullConversationScheduler } from "./queue/conversation.queue";
import { createConversationWorker } from "./queue/conversation.worker";
import { createCrmClient } from "./crm/crm.client";
import { createGreenApiClient } from "./greenapi/greenapi.client";
import { createLlmProvider } from "./agent/llm.provider";
import { createTranscriptionService } from "./transcription/transcription.service";
import { createRedisConnection, createStoreConnection } from "./queue/connection";
import { buildApp, RuntimeState } from "./app";
import { Services } from "./services";

async function waitForRedis(redis: IORedis, logger: Logger, attempts = 30): Promise<void> {
  for (let i = 1; i <= attempts; i += 1) {
    try {
      await redis.ping();
      return;
    } catch (error) {
      if (i === attempts) throw error;
      logger.warn({ attempt: i }, "redis.not_ready.retrying");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const logger = createLogger({ level: config.logLevel, pretty: !config.isProduction });

  logger.info({ nodeEnv: config.nodeEnv }, "Application starting");
  logger.info({ instances: config.instances.length }, "GreenAPI instances loaded");
  if (config.mockExternals) {
    logger.warn("MOCK_EXTERNALS enabled - external services are mocked");
  }

  const storeRedis = createStoreConnection(config.redisUrl);
  const queueRedis = createRedisConnection(config.redisUrl);
  await waitForRedis(storeRedis, logger);
  logger.info("Redis connected");

  const debug = new InMemoryDebugRecorder();
  const store = new RedisConversationStore(storeRedis);
  const scheduler = new BullConversationScheduler(queueRedis, config.queueName);

  const services: Services = {
    config,
    logger,
    store,
    scheduler,
    crm: createCrmClient(config, logger, debug),
    greenApi: createGreenApiClient(config, logger, debug),
    llm: createLlmProvider(config, logger),
    transcription: createTranscriptionService(config, logger),
    debug,
  };

  const runtime: RuntimeState = { redisConnected: true, workerStarted: false };

  let worker: Worker | undefined;
  if (config.workerEnabled) {
    worker = createConversationWorker(services, queueRedis);
    runtime.workerStarted = true;
    logger.info({ concurrency: config.workerConcurrency }, "BullMQ worker started");
  }

  let app: ReturnType<typeof buildApp> | undefined;
  if (config.apiEnabled) {
    app = buildApp(services, runtime);
    await app.listen({ host: config.host, port: config.port });
    logger.info({ port: config.port }, "API started");
  }

  logger.info("Application ready");

  let shuttingDown = false;
  const shutdown = async (signal: string): Promise<void> => {
    if (shuttingDown) return;
    shuttingDown = true;
    logger.info({ signal }, "Application shutting down");
    try {
      if (app) await app.close();
      if (worker) await worker.close();
      await scheduler.close();
      await storeRedis.quit().catch(() => undefined);
      await queueRedis.quit().catch(() => undefined);
    } catch (error) {
      logger.error({ err: (error as Error).message }, "shutdown.error");
    }
    process.exit(0);
  };

  process.on("SIGINT", () => void shutdown("SIGINT"));
  process.on("SIGTERM", () => void shutdown("SIGTERM"));
  process.on("unhandledRejection", (reason) => {
    logger.error({ err: String(reason) }, "unhandledRejection");
  });
  process.on("uncaughtException", (error) => {
    logger.fatal({ err: error.message }, "uncaughtException");
    void shutdown("uncaughtException");
  });
}

void main().catch((error) => {
  // eslint-disable-next-line no-console
  console.error("Fatal startup error:", error);
  process.exit(1);
});
