import { afterEach, describe, expect, it, vi } from "vitest";

const fakeBull = vi.hoisted(() => ({
  queued: [] as { name: string; data: any; options: any }[],
  failedJobs: [] as any[],
  recoveryRanges: [] as [number, number][],
  initialState: "failed" as "failed" | "waiting",
  retry: vi.fn(),
  processor: undefined as ((job: any) => Promise<unknown>) | undefined,
}));

vi.mock("bullmq", () => {
  class Queue {
    constructor(_name: string, _options: unknown) {}
    async add(name: string, data: unknown, options: unknown) {
      fakeBull.queued.push({ name, data, options });
      return {
        getState: async () => fakeBull.initialState,
        retry: fakeBull.retry,
      };
    }
    async getJobCounts() { return { failed: fakeBull.failedJobs.length }; }
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

import { createWebhookProxyWorker, BullWebhookProxy } from "../../src/crm/webhook-proxy";
import { createHarness } from "../helpers/harness";

afterEach(() => {
  vi.unstubAllGlobals();
  fakeBull.queued = [];
  fakeBull.failedJobs = [];
  fakeBull.recoveryRanges = [];
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
    const job = { data: { instanceId: "105907", payload: lidPayload } };
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
    } finally {
      await h.services.webhookProxy.close();
    }
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
