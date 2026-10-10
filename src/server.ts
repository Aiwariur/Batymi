import type IORedis from "ioredis";
import type { Worker } from "bullmq";
import { loadConfig } from "./config/env";
import { createLogger, Logger } from "./observability/logger";
import { InMemoryDebugRecorder } from "./observability/debug-recorder";
import { RedisConversationStore } from "./buffer/redis-store";
import { BullConversationScheduler } from "./queue/conversation.queue";
import { createConversationWorker } from "./queue/conversation.worker";
import { createCrmClient } from "./crm/crm.client";
import { createMessageSender } from "./crm/reply.sender";
import {
  createWebhookProxy,
  createWebhookProxyWorker,
  WebhookProxy,
} from "./crm/webhook-proxy";
import { createLlmProvider } from "./agent/llm.provider";
import { createTranscriptionService } from "./transcription/transcription.service";
import { createRedisConnection, createStoreConnection } from "./queue/connection";
import { buildApp, RuntimeState } from "./app";
import { Services } from "./services";
import { CrmInstanceRegistry } from "./crm/instance-registry";
import { recoverOrphanConversations } from "./queue/conversation-recovery";

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
  const instanceRegistry = config.instanceSource === "crm" ? new CrmInstanceRegistry(config) : undefined;
  await instanceRegistry?.refresh(true);
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
  const webhookProxy: WebhookProxy = createWebhookProxy(config, logger, debug, queueRedis);

  const services: Services = {
    config,
    logger,
    store,
    scheduler,
    crm: createCrmClient(config, logger, debug),
    sender: createMessageSender(config, logger, debug),
    webhookProxy,
    llm: createLlmProvider(config, logger),
    transcription: createTranscriptionService(config, logger),
    debug,
    instanceRegistry,
  };

  const registryTimer = instanceRegistry ? setInterval(() => {
    void instanceRegistry.refresh().catch(error => logger.warn({ err: (error as Error).message }, "crm.instances.refresh_failed"));
  }, 30000) : undefined;
  registryTimer?.unref();

  const runtime: RuntimeState = { redisConnected: true, workerStarted: false };
  let storeRedisHealthy = true;
  let queueRedisHealthy = true;
  const updateRedisReadiness = (): void => {
    runtime.redisConnected = storeRedisHealthy && queueRedisHealthy;
  };
  const registerRedisHealth = (redis: IORedis, setHealthy: (value: boolean) => void): void => {
    redis.on("ready", () => {
      setHealthy(true);
      updateRedisReadiness();
    });
    redis.on("close", () => {
      setHealthy(false);
      updateRedisReadiness();
    });
    redis.on("end", () => {
      setHealthy(false);
      updateRedisReadiness();
    });
    redis.on("error", () => {
      setHealthy(false);
      updateRedisReadiness();
    });
  };
  registerRedisHealth(storeRedis, (value) => {
    storeRedisHealthy = value;
  });
  registerRedisHealth(queueRedis, (value) => {
    queueRedisHealthy = value;
  });

  let worker: Worker | undefined;
  let webhookWorker: Worker | undefined;
  if (config.workerEnabled) {
    worker = createConversationWorker(services, queueRedis);
    worker.on("ready", () => {
      runtime.workerStarted = true;
    });
    worker.on("closed", () => {
      runtime.workerStarted = false;
    });
    if (!config.mockCrm) {
      webhookWorker = createWebhookProxyWorker(config, logger, queueRedis);
    }
    logger.info({ concurrency: config.workerConcurrency }, "BullMQ worker started");
  }

  let recoveryTimer: NodeJS.Timeout | undefined;
  if (config.workerEnabled) {
    let recoveryRunning = false;
    const runRecoveryPass = async (): Promise<void> => {
      if (recoveryRunning) return;
      recoveryRunning = true;
      try {
        runtime.recovery = { ...await recoverOrphanConversations(services), checkedAt: new Date().toISOString() };
        const retried = await webhookProxy.recoverFailed?.();
        if (retried) logger.warn({ retried }, "webhook.forward.recovery.scheduled");
      } catch (error) {
        logger.error({ err: (error as Error).message }, "queue.recovery.pass.failed");
      } finally {
        recoveryRunning = false;
      }
    };
    void runRecoveryPass();
    recoveryTimer = setInterval(() => void runRecoveryPass(), 60_000);
    recoveryTimer.unref();
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
    if (registryTimer) clearInterval(registryTimer);
    if (recoveryTimer) clearInterval(recoveryTimer);
    try {
      if (app) await app.close();
      if (worker) await worker.close();
      if (webhookWorker) await webhookWorker.close();
      await scheduler.close();
      await webhookProxy.close();
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
