import { afterEach, describe, expect, it, vi } from "vitest";

const fakeBull = vi.hoisted(() => ({
  queued: [] as { name: string; data: any; options: any }[],
  failedJobs: [] as any[],
  recoveryRanges: [] as [number, number][],
  outstanding: { wait: 0, active: 0, delayed: 0, paused: 0, failed: 0, prioritized: 0 } as Record<string, number>,
  existingJobs: new Map<string, any>(),
  initialState: "failed" as "failed" | "waiting",
  retry: vi.fn(),
  processor: undefined as ((job: any) => Promise<unknown>) | undefined,
}));

vi.mock("bullmq", () => {
  class Queue {
    constructor(_name: string, _options: unknown) {}
    async add(name: string, data: unknown, options: unknown) {
      fakeBull.queued.push({ name, data, options });
      const job = {
        getState: async () => fakeBull.initialState,
        retry: fakeBull.retry,
      };
      fakeBull.existingJobs.set((options as { jobId: string }).jobId, job);
      return job;
    }
    async getJob(jobId: string) { return fakeBull.existingJobs.get(jobId); }
    async getJobCounts(...states: string[]) {
      return Object.fromEntries(states.map(state => [state, state === "failed" ? fakeBull.failedJobs.length : fakeBull.outstanding[state] ?? 0]));
    }
    async getJobs(_states: unknown, start: number, end: number) {
      fakeBull.recoveryRanges.push([start, end]);
      return fakeBull.failedJobs.slice(start, end + 1);
    }
    async close() {}
  }
  class Worker {
    constructor(_name: string, processor: (job: any) => Promise<unknown>, _options: unknown) {
      fakeBull.processor = processor;
    }
    on() { return this; }
  }
  return { Queue, Worker };
});

import { createWebhookProxyWorker, BullWebhookProxy, webhookForwardJobId } from "../../src/crm/webhook-proxy";
import { createHarness } from "../helpers/harness";

afterEach(() => {
  vi.unstubAllGlobals();
  fakeBull.queued = [];
  fakeBull.failedJobs = [];
  fakeBull.recoveryRanges = [];
  fakeBull.outstanding = { wait: 0, active: 0, delayed: 0, paused: 0, failed: 0, prioritized: 0 };
  fakeBull.existingJobs = new Map();
  fakeBull.initialState = "failed";
  fakeBull.retry.mockReset();
  fakeBull.processor = undefined;
});

const lidPayload = {
  event: "message",
  instanceId: "105907",
  data: { message: {
    id: { _serialized: "false_opaque@lid_full-provider-id", fromMe: false },
    fromMe: false, from: "opaque@lid", to: "opaque@lid", type: "chat", body: "Да, готов сотрудничать", timestamp: 1_791_705_600,
  } },
};

const inlineAudioPayload = {
  event: "message",
  instanceId: "105907",
  data: { message: {
    id: { _serialized: "false_99555123456@c.us_audio-full-id", fromMe: false },
    fromMe: false, from: "99555123456@c.us", to: "19995550100@c.us", type: "ptt", body: "caption", timestamp: 1_791_705_600,
  }, media: { data: "AQID", mimetype: "audio/ogg; codecs=opus", filename: "private.ogg", filesize: 3 } },
};

function processorJob(data: any) {
  const job: any = { data, updateData: vi.fn(async (next: unknown) => { job.data = next; }) };
  return job;
}

describe("WaAPI webhook proxy recovery", () => {
  it("retries the retained failed job with the same identity and payload", async () => {
    const proxy = new BullWebhookProxy({} as never);
    await proxy.forward("105907", lidPayload);
    expect(fakeBull.queued).toHaveLength(1);
    expect(fakeBull.queued[0].data).toEqual({ instanceId: "105907", payload: lidPayload });
    expect(fakeBull.retry).toHaveBeenCalledWith("failed");
    await proxy.close();
  });

  it("recovers failed jobs in bounded pages and records a retry budget", async () => {
    fakeBull.failedJobs = Array.from({ length: 105 }, (_, index) => {
      const job: any = { data: { instanceId: "105907", payload: lidPayload },
        retry: vi.fn(async () => undefined),
        updateData: vi.fn(async (data: unknown) => { job.data = data; }) };
      if (index === 104) job.data.recoveryAttempts = 3;
      return job;
    });
    const proxy = new BullWebhookProxy({} as never);
    expect(await proxy.recoverFailed()).toBe(100);
    expect(fakeBull.recoveryRanges[0]).toEqual([0, 99]);
    expect(fakeBull.failedJobs[0].data.recoveryAttempts).toBe(1);
    expect(fakeBull.failedJobs[99].retry).toHaveBeenCalledTimes(1);
    expect(fakeBull.failedJobs[104].retry).not.toHaveBeenCalled();
    expect(await proxy.recoverFailed()).toBe(4);
    expect(fakeBull.recoveryRanges[1]).toEqual([100, 199]);
    expect(fakeBull.failedJobs[100].data.recoveryAttempts).toBe(1);
    await proxy.close();
  });

  it("replays after CRM receipt but failed LID ingest, then buffers once after resolution", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "test-line-secret" });
    h.config.crmBaseUrl = "https://crm.example/api";
    h.config.waapiApiToken = "test-account-token";
    const fetcher = vi.fn()
      .mockResolvedValueOnce({ ok: true }) // CRM receipt on first delivery
      .mockResolvedValueOnce({ ok: false, status: 503 }) // LID resolver fails after CRM receipt
      .mockResolvedValueOnce({ ok: true }) // idempotent CRM replay
      .mockResolvedValueOnce({ ok: true, json: async () => ({ status: "success", data: { status: "success",
        data: { contacts: [{ lid: "opaque@lid", pn: "99555123456@c.us" }] } } }) });
    vi.stubGlobal("fetch", fetcher);

    createWebhookProxyWorker(h.config, h.services.logger, {} as never, h.services);
    const processJob = fakeBull.processor;
    expect(processJob).toBeDefined();
    const job = processorJob({ instanceId: "105907", payload: lidPayload });
    try {
      await expect(processJob!(job)).rejects.toThrow("WaAPI LID resolution unavailable");
      expect(h.scheduler.jobs).toHaveLength(0);
      await processJob!(job);
      expect(fetcher.mock.calls[0][0]).toBe("https://crm.example/api/waapi/webhook/105907/test-line-secret");
      expect(fetcher.mock.calls[2][0]).toBe("https://crm.example/api/waapi/webhook/105907/test-line-secret");
      expect(h.scheduler.jobs).toHaveLength(1);
      expect(h.scheduler.jobs[0].conversationKey).toBe("105907:99555123456@c.us");
      const pending = await h.store.drainPending("105907:99555123456@c.us");
      expect(pending.map(message => message.idMessage)).toContain("false_opaque@lid_full-provider-id");
      expect(job.updateData).toHaveBeenCalledTimes(1);
      expect(job.data.payload.data.media?.data).toBeUndefined();
    } finally {
      await h.services.webhookProxy.close();
    }
  });

  it("buffers inline audio, then strips its blob from the completed proxy job", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "test-line-secret" });
    h.config.crmBaseUrl = "https://crm.example/api";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true }));
    createWebhookProxyWorker(h.config, h.services.logger, {} as never, h.services);
    const job = processorJob({ instanceId: "105907", payload: inlineAudioPayload });
    try {
      await fakeBull.processor!(job);
      expect(h.scheduler.jobs).toHaveLength(1);
      const pending = await h.store.drainPending("105907:99555123456@c.us");
      expect(pending).toHaveLength(1);
      expect(pending[0].audio).toMatchObject({ data: "AQID", mimetype: "audio/ogg; codecs=opus" });
      expect(job.updateData).toHaveBeenCalledTimes(1);
      expect(job.data.payload.data.media).toEqual({ mimetype: "audio/ogg; codecs=opus", filename: "private.ogg", filesize: 3 });
    } finally {
      await h.services.webhookProxy.close();
    }
  });

  it("retains inline audio when ingestion fails after CRM receipt for retry", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "test-line-secret" });
    h.config.crmBaseUrl = "https://crm.example/api";
    h.config.waapiApiToken = "test-account-token";
    vi.stubGlobal("fetch", vi.fn()
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: false, status: 503 }));
    createWebhookProxyWorker(h.config, h.services.logger, {} as never, h.services);
    const retryableAudioPayload = {
      ...inlineAudioPayload,
      data: { ...inlineAudioPayload.data, message: { ...inlineAudioPayload.data.message, from: "opaque@lid" } },
    };
    const job = processorJob({ instanceId: "105907", payload: retryableAudioPayload });
    try {
      await expect(fakeBull.processor!(job)).rejects.toThrow("WaAPI LID resolution unavailable");
      expect(job.updateData).not.toHaveBeenCalled();
      expect(job.data.payload.data.media.data).toBe("AQID");
      expect(h.scheduler.jobs).toHaveLength(0);
    } finally {
      await h.services.webhookProxy.close();
    }
  });

  it("rejects new webhook jobs at capacity with a safe error but allows retained duplicates", async () => {
    const proxy = new BullWebhookProxy({} as never);
    fakeBull.outstanding.wait = 100;
    let error: unknown;
    try {
      await proxy.forward("105907", inlineAudioPayload);
    } catch (caught) { error = caught; }
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toMatch(/queue|capacity|limit/i);
    expect((error as Error).message).not.toContain(inlineAudioPayload.data.media.data);
    expect(fakeBull.queued).toHaveLength(0);

    const jobId = (fakeBull.queued[0]?.options as { jobId?: string } | undefined)?.jobId;
    const retainedId = jobId ?? "retained-waapi-job";
    const retry = vi.fn(async () => undefined);
    fakeBull.existingJobs.set(retainedId, { getState: async () => "failed", retry });
    // Expose the retained ID to the proxy's deduplication lookup through the same
    // deterministic key used for new submissions.
    const jobKey = webhookForwardJobId("105907", inlineAudioPayload);
    fakeBull.existingJobs.set(jobKey, { getState: async () => "failed", retry });
    expect(fakeBull.existingJobs.get(jobKey)).toBeDefined();
    await expect(proxy.forward("105907", inlineAudioPayload)).resolves.toBeUndefined();
    expect(retry).toHaveBeenCalledWith("failed");
    expect(fakeBull.queued).toHaveLength(0);
    await proxy.close();
  });
  it("keeps delivery and metadata receipts flowing when audio admission is at capacity", async () => {
    const proxy = new BullWebhookProxy({} as never);
    fakeBull.outstanding.failed = 100;
    const ack = { ...inlineAudioPayload, event: "message_ack", data: { message: { ...inlineAudioPayload.data.message, ack: 2 } } };
    await expect(proxy.forward("105907", ack)).resolves.toBeUndefined();
    expect(fakeBull.queued).toHaveLength(1);
    await proxy.close();
  });

  it("does not ingest when CRM rejects the durable webhook write", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "test-line-secret" });
    h.config.crmBaseUrl = "https://crm.example/api";
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    createWebhookProxyWorker(h.config, h.services.logger, {} as never, h.services);
    try {
      await expect(fakeBull.processor!({ data: { instanceId: "105907", payload: {
        ...lidPayload, data: { message: { ...lidPayload.data.message, from: "99555123456@c.us" } },
      } } })).rejects.toThrow("CRM webhook failed: HTTP 503");
      expect(h.scheduler.jobs).toHaveLength(0);
      expect(h.debug.snapshot().outgoing).toHaveLength(0);
    } finally {
      await h.services.webhookProxy.close();
    }
  });
});
