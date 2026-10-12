import { createHash } from "crypto";
import { Queue, Worker } from "bullmq";
import type IORedis from "ioredis";
import { Config } from "../config/env";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { Services } from "../services";
import { waApiWebhookSchema } from "../waapi/waapi.schemas";
import { ingestWaApiPayload } from "../webhooks/waapi.routes";

const WEBHOOK_FORWARD_QUEUE = "webhook-forward";
const REQUEST_TIMEOUT_MS = 15000;

export interface WebhookProxyJobData {
  instanceId: string;
  payload: unknown;
  recoveryAttempts?: number;
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
  if (typeof body?.event === "string") {
    const parsed = waApiWebhookSchema.parse(payload);
    return `waapi_${createHash("sha256").update(JSON.stringify({ instanceId, event: parsed.event,
      id: parsed.data.message?.id._serialized,
      ack: parsed.event === "message_ack" ? parsed.data.message?.ack : undefined,
      // Connection/status events have no message identity.
      status: parsed.data.message ? undefined : parsed.data })).digest("hex")}`;
  }
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
 * Durable proxy for legacy GreenAPI and WaAPI events to the CRM.
 *
 * Batymi — получатель вебхуков провайдера, но CRM остаётся
 * источником правды по interactions (диалоги, has_reply, delivery-статусы,
 * воронка). Каждый сырой вебхук ставится в очередь и форвардится в
 * Provider-specific CRM path with retries. WaAPI jobs also own inbound
 * buffering after CRM receipt; acknowledgement waits only for durable enqueue.
 */
export interface WebhookProxy {
  handlesWaApiIngress?: boolean;
  /** Resolves only once the forwarding job has been durably accepted by BullMQ. */
  forward(instanceId: string, payload: unknown): Promise<void>;
  recoverFailed?(): Promise<number>;
  close(): Promise<void>;
}

export class BullWebhookProxy implements WebhookProxy {
  readonly handlesWaApiIngress = true;
  private readonly queue: Queue<WebhookProxyJobData>;
  private failedRecoveryOffset = 0;

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
    const jobId = webhookForwardJobId(instanceId, payload);
    const job = await this.queue.add(
      "forward",
      { instanceId, payload },
      { jobId },
    );
    // BullMQ deduplicates by job id, including jobs retained in failed state.
    // Provider redelivery is an explicit signal to retry this idempotent CRM
    // write; completed jobs remain deduplicated for the ingress TTL.
    if ((await job.getState()) === "failed") await job.retry("failed");
  }

  async recoverFailed(): Promise<number> {
    const failedCount = (await this.queue.getJobCounts("failed")).failed ?? 0;
    if (failedCount === 0) {
      this.failedRecoveryOffset = 0;
      return 0;
    }
    const start = this.failedRecoveryOffset % failedCount;
    const jobs = await this.queue.getJobs(["failed"], start, start + 99, true);
    this.failedRecoveryOffset = (start + jobs.length) % failedCount;
    let retried = 0;
    for (const job of jobs) {
      const attempts = job.data.recoveryAttempts ?? 0;
      if (attempts >= 3) continue;
      await job.updateData({ ...job.data, recoveryAttempts: attempts + 1 });
      await job.retry("failed");
      retried += 1;
    }
    return retried;
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

export async function postWebhookToCrm(
  config: Config,
  instanceId: string,
  payload: unknown,
): Promise<void> {
  if (!config.crmBaseUrl) throw new Error("CRM_BASE_URL is not configured");
  const waapi = payload && typeof payload === "object" && "event" in payload;
  const instance = config.instances.find(row => row.id === instanceId);
  if (waapi && (instance?.provider !== "waapi" || !instance.webhookSecret)) throw Error("CRM WaAPI line unavailable");
  const forwarded = waapi ? stripWaApiMedia(payload) : payload;
  const path = waapi ? `/waapi/webhook/${encodeURIComponent(instanceId)}/${encodeURIComponent(instance!.webhookSecret!)}`
    : `/greenapi/webhook/${encodeURIComponent(instanceId)}`;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(
      `${config.crmBaseUrl}${path}`,
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(config.crmApiKey ? { "X-API-Key": config.crmApiKey } : {}),
          ...(!waapi && config.webhookSecret ? { Authorization: `Bearer ${config.webhookSecret}` } : {}),
        },
        body: JSON.stringify(forwarded),
        signal: controller.signal,
      },
    );
    if (!response.ok) {
      throw new Error(`CRM webhook failed: HTTP ${response.status}`);
    }
  } catch (error) {
    if (error instanceof Error && /^CRM webhook failed: HTTP \d+$/.test(error.message)) throw error;
    throw Error("CRM webhook request unavailable");
  } finally {
    clearTimeout(timer);
  }
}

export function stripWaApiMedia(payload: unknown): unknown {
  const parsed = waApiWebhookSchema.parse(payload);
  const media = parsed.data.media;
  const m = parsed.data.message;
  const { media: _media, message: _message, _data: _raw, ...metadata } = parsed.data;
  const message = m ? { id: { _serialized: m.id._serialized, fromMe: m.id.fromMe, remote: m.id.remote },
    fromMe: m.fromMe, from: m.from, to: m.to, type: m.type, body: m.body, timestamp: m.timestamp,
    ack: m.ack, hasMedia: m.hasMedia, isStatus: m.isStatus, isGroupMsg: m.isGroupMsg } : undefined;
  return { event: parsed.event, instanceId: parsed.instanceId, data: { ...metadata, ...(message ? { message } : {}), ...(media ? { media: {
    mimetype: media.mimetype, ...(media.filename ? { filename: media.filename } : {}),
    ...(media.filesize !== undefined ? { filesize: media.filesize } : {}),
  } } : {}) } };
}

export function createWebhookProxyWorker(
  config: Config,
  logger: Logger,
  connection: IORedis,
  services?: Services,
): Worker<WebhookProxyJobData> {
  const worker = new Worker<WebhookProxyJobData>(
    WEBHOOK_FORWARD_QUEUE,
    async (job) => {
      await postWebhookToCrm(config, job.data.instanceId, job.data.payload);
      if (job.data.payload && typeof job.data.payload === "object" && "event" in job.data.payload) {
        if (!services) throw Error("WaAPI ingress services unavailable");
        await ingestWaApiPayload(job.data.instanceId, waApiWebhookSchema.parse(job.data.payload), services);
      }
    },
    { connection, concurrency: 10 },
  );

  worker.on("failed", (job) => {
    const final = job && job.attemptsMade >= (job.opts.attempts ?? 1);
    const log = final ? logger.error.bind(logger) : logger.warn.bind(logger);
    log(
      { jobId: job?.id, instanceId: job?.data?.instanceId, final },
      "webhook.forward.failed",
    );
  });
  worker.on("error", () => {
    logger.error("webhook.forward.worker.error");
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
