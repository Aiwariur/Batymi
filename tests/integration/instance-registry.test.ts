import { afterEach, describe, expect, it, vi } from "vitest";
import { loadConfig } from "../../src/config/env";
import { CrmInstanceRegistry } from "../../src/crm/instance-registry";
import { createHarness } from "../helpers/harness";
import { buildApp } from "../../src/app";
import { buildSimulatedPayload } from "../../src/webhooks/greenapi.routes";

const row = (instanceId: string, isActive = true) => ({ instanceId, name: instanceId, isActive });
const response = (rows: unknown) => ({ ok: true, json: async () => rows });
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("CRM instance membership", () => {
  it("uses active CRM lines and removes env-only IDs without losing explicit manager routing", async () => {
    const config = loadConfig({ GREENAPI_INSTANCES: JSON.stringify([{ id: "1001", managerId: 4 }, { id: "9999" }]),
      CRM_BASE_URL: "https://crm.example/api", CRM_API_KEY: "test-key" });
    const fetcher = vi.fn().mockResolvedValue(response([row("1001"), row("1002"), row("1003", false)]));
    vi.stubGlobal("fetch", fetcher);
    const registry = new CrmInstanceRegistry(config);
    await registry.refresh();
    expect(config.instances.map(i => i.id)).toEqual(["1001", "1002"]);
    expect(config.instances[0].managerId).toBe(4);
    expect(fetcher.mock.calls[0][0]).toBe("https://crm.example/api/whatsapp-instances");
    expect(fetcher.mock.calls[0][1].headers).toEqual({ "X-API-Key": "test-key" });
  });

  it("accepts a newly added CRM instance at ingress without an env edit or restart", async () => {
    const h = createHarness({ CRM_BASE_URL: "https://crm.example/api", CRM_API_KEY: "test-key", GREENAPI_INSTANCE_SOURCE: "crm" });
    const fetcher = vi.fn().mockResolvedValueOnce(response([row("1001")]))
      .mockResolvedValue(response([row("1001"), row("1002")]));
    vi.stubGlobal("fetch", fetcher);
    h.services.instanceRegistry = new CrmInstanceRegistry(h.config);
    await h.services.instanceRegistry.refresh();
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    try {
      const r = await app.inject({ method: "POST", url: "/webhooks/greenapi/1002", payload:
        buildSimulatedPayload({ instanceId: "1002", chatId: "995555123456@c.us", text: "Ссылка?", idMessage: "new-line" }) });
      expect(r.statusCode).toBe(200);
      expect(r.json().buffered).toBe(true);
      expect(h.scheduler.jobs[0].conversationKey).toBe("1002:995555123456@c.us");
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("refreshes membership after 30 seconds and rejects a disabled instance", async () => {
    vi.useFakeTimers();
    const config = loadConfig({ CRM_BASE_URL: "https://crm.example/api", CRM_API_KEY: "test-key" });
    const fetcher = vi.fn().mockResolvedValue(response([row("1001")]));
    vi.stubGlobal("fetch", fetcher);
    const registry = new CrmInstanceRegistry(config);
    await registry.refresh();
    await registry.resolve("1001");
    expect(fetcher).toHaveBeenCalledTimes(1);
    fetcher.mockResolvedValue(response([row("1001", false)]));
    vi.advanceTimersByTime(30001);
    expect(await registry.resolve("1001")).toBeUndefined();
    expect(config.instances).toEqual([]);
  });

  it("returns retryable ingress failure if CRM refresh fails, with no buffering or forwarding", async () => {
    const h = createHarness({ CRM_BASE_URL: "https://crm.example/api", CRM_API_KEY: "test-key" });
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false, status: 503 }));
    h.services.instanceRegistry = new CrmInstanceRegistry(h.config);
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    try {
      const r = await app.inject({ method: "POST", url: "/webhooks/greenapi/1002", payload:
        buildSimulatedPayload({ instanceId: "1002", chatId: "995555123456@c.us", text: "Ссылка?", idMessage: "crm-down" }) });
      expect(r.statusCode).toBe(503);
      expect(h.scheduler.jobs).toHaveLength(0);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    } finally { await app.close(); }
  });
});
