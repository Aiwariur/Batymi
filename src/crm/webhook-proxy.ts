import { createHash } from "crypto";
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
 * A webhook can be retried by GreenAPI, by Fastify after a response timeout,
 * or by the proxy worker after a lost CRM response. Keep one deterministic
 * BullMQ id for the whole idempotency window so those retries do not create
 * multiple CRM interactions. The full payload is the fallback for delivery
 * events without an idMessage.
 */
export function webhookForwardJobId(instanceId: string, payload: unknown): string {
  const body = payload && typeof payload === "object" ? payload as Record<string, unknown> : undefined;
  const idMessage = typeof body?.idMessage === "string" ? body.idMessage : undefined;
  // GreenAPI may retry the same id with a new timestamp or object key order.
  // Delivery updates for one message can legitimately have different status
  // values, so status remains part of their key.
  const source = idMessage
    ? {
        instanceId,
        typeWebhook: body?.typeWebhook,
        idMessage,
        status: body?.status,
      }
    : { instanceId, payload };
  return `webhook_${createHash("sha256").update(JSON.stringify(source)).digest("hex")}`;
}

/**
 * Прозрачный прокси вебхуков GreenAPI в арендную CRM.
 *
 * Batymi — единственный получатель вебхуков GreenAPI, но CRM остаётся
 * источником правды по interactions (диалоги, has_reply, delivery-статусы,
 * воронка). Каждый сырой вебхук ставится в очередь и форвардится в
 * POST /api/greenapi/webhook/<instanceId> с повторами; ack GreenAPI ждёт
 * только подтверждения постановки BullMQ job, а не ответа CRM.
 */
export interface WebhookProxy {
  /** Resolves only once the forwarding job has been durably accepted by BullMQ. */
  forward(instanceId: string, payload: unknown): Promise<void>;
  close(): Promise<void>;
}

export class BullWebhookProxy implements WebhookProxy {
  private readonly queue: Queue<WebhookProxyJobData>;

  constructor(connection: IORedis, idempotencyTtlSeconds = 86400) {
    this.queue = new Queue<WebhookProxyJobData>(WEBHOOK_FORWARD_QUEUE, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 2000 },
        // Retain completed job ids through the ingress idempotency window.
        // Otherwise a retry after a lost CRM response could create a second
        // interaction once BullMQ has removed the completed job.
        removeOnComplete: { age: Math.max(60, idempotencyTtlSeconds) },
        removeOnFail: 1000,
      },
    });
  }

  async forward(instanceId: string, payload: unknown): Promise<void> {
    await this.queue.add(
      "forward",
      { instanceId, payload },
      { jobId: webhookForwardJobId(instanceId, payload) },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}

export class MockWebhookProxy implements WebhookProxy {
  private readonly forwarded = new Set<string>();

  constructor(private readonly debug: DebugRecorder) {}

  async forward(instanceId: string, payload: unknown): Promise<void> {
    const jobId = webhookForwardJobId(instanceId, payload);
    if (this.forwarded.has(jobId)) return;
    this.forwarded.add(jobId);
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
        headers: {
          "Content-Type": "application/json",
          ...(config.crmApiKey ? { "X-API-Key": config.crmApiKey } : {}),
          ...(config.webhookSecret ? { Authorization: `Bearer ${config.webhookSecret}` } : {}),
        },
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
  return new BullWebhookProxy(connection, config.idempotencyTtlSeconds);
}
