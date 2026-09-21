import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import { Config } from "../config/env";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";

const WEBHOOK_FORWARD_QUEUE = "webhook-forward";
const REQUEST_TIMEOUT_MS = 15000;

export interface WebhookProxyJobData {
  instanceId: string;
  payload: unknown;
}

/**
 * Прозрачный прокси вебхуков GreenAPI в арендную CRM.
 *
 * Batymi — единственный получатель вебхуков GreenAPI, но CRM остаётся
 * источником правды по interactions (диалоги, has_reply, delivery-статусы,
 * воронка). Каждый сырой вебхук ставится в очередь и форвардится в
 * POST /api/greenapi/webhook/<instanceId> с повторами; ack GreenAPI
 * не блокируется.
 */
export interface WebhookProxy {
  forward(instanceId: string, payload: unknown): void;
  close(): Promise<void>;
}

export class BullWebhookProxy implements WebhookProxy {
  private readonly queue: Queue<WebhookProxyJobData>;

  constructor(connection: IORedis) {
    this.queue = new Queue<WebhookProxyJobData>(WEBHOOK_FORWARD_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    });
  }

  forward(instanceId: string, payload: unknown): void {
    void this.queue
      .add("forward", { instanceId, payload }, { jobId: undefined })
      .catch(() => undefined);
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class MockWebhookProxy implements WebhookProxy {
  constructor(private readonly debug: DebugRecorder) {}

  forward(instanceId: string, payload: unknown): void {
    this.debug.recordForwardedWebhook(instanceId, payload);
  }

  async close(): Promise<void> {
    /* noop */
  }
}

async function postWebhookToCrm(
  config: Config,
  instanceId: string,
  payload: unknown,
): Promise<void> {
  if (!config.crmBaseUrl) throw new Error("CRM_BASE_URL is not configured");

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.crmBaseUrl}/greenapi/webhook/${encodeURIComponent(instanceId)}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`HTTP ${response.status} ${body.slice(0, 200)}`);
    }
  } finally {
    clearTimeout(timer);
  }
}

export function createWebhookProxyWorker(
  config: Config,
  logger: Logger,
  connection: IORedis,
): Worker<WebhookProxyJobData> {
  const worker = new Worker<WebhookProxyJobData>(
    WEBHOOK_FORWARD_QUEUE,
    async (job) => {
      await postWebhookToCrm(config, job.data.instanceId, job.data.payload);
    },
    { connection, concurrency: 10 },
  );

  worker.on("failed", (job, error) => {
    const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    const log = final ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(
      { jobId: job?.id, instanceId: job?.data?.instanceId, err: error.message, final },
      "webhook.forward.failed",
    );
  });
  worker.on("error", (error) => {
    logger.error({ err: error.message }, "webhook.forward.worker.error");
  });

  return worker;
}

export function createWebhookProxy(
  config: Config,
  logger: Logger,
  debug: DebugRecorder,
  connection?: IORedis,
): WebhookProxy {
  if (config.mockCrm || !connection) {
    return new MockWebhookProxy(debug);
  }
  return new BullWebhookProxy(connection);
}
