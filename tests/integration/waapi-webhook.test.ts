import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { createHarness } from "../helpers/harness";
import { CrmInstanceRegistry } from "../../src/crm/instance-registry";
import { webhookForwardJobId, postWebhookToCrm } from "../../src/crm/webhook-proxy";
import { loadConfig } from "../../src/config/env";
import { createLogger } from "../../src/observability/logger";

const pn = "995555123456@c.us";
const fixture = (event = "message", id = "false_opaque@lid_FULL_out", ack = 1) => ({
  event, instanceId: 105907, data: { message: { id: { _serialized: id }, fromMe: event !== "message",
    from: pn, to: pn, body: "Да", type: "chat", timestamp: 1791705600, ack } },
});
function setup() {
  const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "line-secret" });
  const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
  return { h, app, post: (payload: Record<string, unknown>, secret = "line-secret") => app.inject({ method: "POST",
    url: `/webhooks/waapi/105907/${secret}`, payload }) };
}
afterEach(() => vi.unstubAllGlobals());
describe("WaAPI transport", () => {
  it("rejects production env membership; preserves mixed providers in the local fallback", () => {
    expect(() => loadConfig({ NODE_ENV: "production", WAAPI_INSTANCE_ID: "105907" })).toThrow("CRM instance registry");
    const config = loadConfig({ WAAPI_INSTANCE_ID: "105907", GREENAPI_INSTANCES: '[{"id":"legacy"}]' });
    expect(config.instances.map(i => i.id)).toEqual(["105907", "legacy"]);
    expect(loadConfig({ WHATSAPP_INSTANCE_SOURCE: "crm" }).instanceSource).toBe("crm");
  });
  it("rejects WaAPI lines on legacy ingress and admits a WaAPI-only readiness profile", async () => {
    const { h, app } = setup();
    try {
      expect((await app.inject({ method: "POST", url: "/webhooks/greenapi/105907", payload: {} })).statusCode).toBe(404);
      h.config.isProduction = true;
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(200);
      h.config.instances[0].webhookSecret = undefined;
      expect((await app.inject({ method: "GET", url: "/health/ready" })).statusCode).toBe(503);
    } finally { await app.close(); }
  });
  it("excludes system/group/broadcast messages and isolates distinct instances", async () => {
    const { h, app, post } = setup();
    try {
      for (const from of ["120363@g.us", "status@broadcast", "invalid"]) {
        await post({ ...fixture(), data: { message: { ...fixture().data.message, from } } });
      }
      await post({ ...fixture(), data: { message: { ...fixture().data.message, type: "e2e_notification" } } });
      expect(h.scheduler.jobs).toHaveLength(0);
      h.config.instances.push({ id: "105908", token: "", provider: "waapi", webhookSecret: "second-secret" });
      await post(fixture());
      await app.inject({ method: "POST", url: "/webhooks/waapi/105908/second-secret", payload: { ...fixture(), instanceId: "105908" } });
      expect(h.scheduler.jobs.map(j => j.conversationKey)).toEqual([`105907:${pn}`, `105908:${pn}`]);
    } finally { await app.close(); }
  });
  it("acks durable acceptance before ingestion and returns 503 on enqueue failure", async () => {
    const { h, app, post } = setup();
    const forward = vi.fn().mockResolvedValue(undefined);
    h.services.webhookProxy = { handlesWaApiIngress: true, forward, close: async () => {} };
    try {
      expect((await post(fixture())).json()).toEqual({ ok: true, queued: true });
      expect(h.scheduler.jobs).toHaveLength(0);
      forward.mockRejectedValueOnce(Error("queue down"));
      expect((await post(fixture())).statusCode).toBe(503);
      expect(h.scheduler.jobs).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("never writes a path secret or webhook content to application logs", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "line-secret" });
    const lines: string[] = [];
    h.services.logger = createLogger({ level: "trace", pretty: false }, { write: line => { lines.push(line); } });
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    try {
      await app.inject({ method: "POST", url: "/webhooks/waapi/105907/line-secret", payload: fixture() });
      await app.inject({ method: "POST", url: "/webhooks/waapi/105907/line-secret/unknown", payload: { body: "private-content" } });
      h.services.logger.info({ req: { url: "/webhooks/waapi/105907/line-secret", headers: {} }, webhookSecret: "line-secret" }, "request");
      const logs = lines.join("");
      expect(logs).not.toContain("line-secret");
      expect(logs).not.toContain("private-content");
      expect(logs).not.toContain('"Да"');
    } finally { await app.close(); }
  });
  it("rejects secret, instance and malformed message before queue side effects", async () => {
    const { h, app, post } = setup();
    try {
      expect((await post(fixture(), "wrong")).statusCode).toBe(401);
      expect((await post({ ...fixture(), instanceId: "different" })).statusCode).toBe(400);
      expect((await post({ ...fixture(), data: {} })).statusCode).toBe(400);
      expect(h.scheduler.jobs).toHaveLength(0);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("logs safe diagnostics for malformed authenticated payloads without logging submitted values", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "line-secret" });
    const lines: string[] = [];
    h.services.logger = createLogger({ level: "trace", pretty: false }, { write: line => { lines.push(line); } });
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    const payload = {
      ...fixture(),
      data: { message: { ...fixture().data.message, type: "ptt", timestamp: "private_text",
        _serialized: "fake_secret", media: { data: "BASE64_PRIVATE_MARKER", filename: "private_text" } } },
      private: "private_text",
    };
    try {
      expect((await app.inject({ method: "POST", url: "/webhooks/waapi/105907/line-secret", payload })).statusCode).toBe(400);
      const records = lines.map(line => JSON.parse(line));
      const diagnostic = records.find(record => record.reason === "schema_rejected");
      expect(diagnostic).toMatchObject({ instanceId: "105907", messageType: "ptt", reason: "schema_rejected" });
      expect(diagnostic.issues).toEqual(expect.arrayContaining([
        expect.objectContaining({ code: expect.any(String), path: ["data", "message", "timestamp"] }),
      ]));
      const logs = lines.join("");
      for (const privateValue of ["line-secret", "fake_secret", "private_text", "BASE64_PRIVATE_MARKER"]) {
        expect(logs).not.toContain(privateValue);
      }
    } finally { await app.close(); }
  });
  it("logs a fixed safe reason when inline audio is missing and preserves the 400 response", async () => {
    const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "line-secret" });
    const lines: string[] = [];
    h.services.logger = createLogger({ level: "trace", pretty: false }, { write: line => { lines.push(line); } });
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    const payload = { ...fixture(), data: { message: { ...fixture().data.message, type: "ptt" } } };
    try {
      expect((await app.inject({ method: "POST", url: "/webhooks/waapi/105907/line-secret", payload })).statusCode).toBe(400);
      const records = lines.map(line => JSON.parse(line));
      expect(records).toContainEqual(expect.objectContaining({ instanceId: "105907", messageType: "ptt",
        reason: "invalid_audio_base64" }));
      const logs = lines.join("");
      for (const privateValue of ["line-secret", "private_text", "BASE64_PRIVATE_MARKER"]) {
        expect(logs).not.toContain(privateValue);
      }
    } finally { await app.close(); }
  });
  it("buffers only inbound message, retains literal ID and deduplicates duplicates", async () => {
    const { h, app, post } = setup();
    try {
      expect((await post(fixture())).json().buffered).toBe(true);
      expect((await post(fixture())).json().reason).toBe("duplicate");
      for (const event of ["message_create", "message_ack", "disconnected", "auth_failure"]) {
        expect((await post(fixture(event))).statusCode).toBe(200);
      }
      expect(h.scheduler.jobs).toHaveLength(1);
      expect(h.scheduler.jobs[0].conversationKey).toBe(`105907:${pn}`);
    } finally { await app.close(); }
  });
  it("uses real PN for LID, same buffer for both variants; unknown LID never becomes a phone", async () => {
    const { h, app, post } = setup();
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, json: async () => ({ status: "success",
      data: { status: "success", data: { contacts: [{ lid: "opaque@lid", pn }] } } }) }));
    h.config.waapiApiToken = "account-test";
    try {
      await post({ ...fixture(), data: { message: { ...fixture().data.message, from: "opaque@lid" } } });
      await post(fixture("message", "second-full-id"));
      expect(h.scheduler.jobs.map(j => j.conversationKey)).toEqual([`105907:${pn}`, `105907:${pn}`]);
      const r = await post({ ...fixture("message", "unknown-lid"), data: { message: { ...fixture().data.message, from: "unknown@lid" } } });
      expect(r.json().buffered).not.toBe(true);
      expect(h.scheduler.jobs).toHaveLength(2);
    } finally { await app.close(); }
  });
  it("ack jobs differ by ack and event, retries with changed timestamp have the same key", () => {
    expect(webhookForwardJobId("105907", fixture("message_ack", "id", 2)))
      .not.toBe(webhookForwardJobId("105907", fixture("message_ack", "id", 3)));
    const changed = fixture(); changed.data.message.timestamp += 10;
    expect(webhookForwardJobId("105907", fixture())).toBe(webhookForwardJobId("105907", changed));
    expect(webhookForwardJobId("105907", fixture())).not.toBe(webhookForwardJobId("105907", fixture("message_create")));
  });
  it("loads private CRM metadata/secrets; null manager keeps override", async () => {
    const { h, app } = setup();
    h.config.crmBaseUrl = "https://crm.example/api"; h.config.crmApiKey = "private-key";
    h.config.instances[0].managerId = 4;
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ instanceId: "105907", name: "line",
      isActive: true, provider: "waapi", managerId: null, webhookSecret: "crm-secret", baseUrl: "https://waapi.app/api/v1" }] });
    vi.stubGlobal("fetch", fetcher);
    try {
      await new CrmInstanceRegistry(h.config).refresh();
      expect(fetcher.mock.calls[0][0]).toBe("https://crm.example/api/whatsapp-instances?includeSecrets=1");
      expect(h.config.instances[0]).toMatchObject({ managerId: 4, webhookSecret: "crm-secret", provider: "waapi", token: "" });
    } finally { await app.close(); }
  });
  it("rejects registry errors and missing secrets before ingress side effects, sanitizing concurrent failures", async () => {
    const { h, app, post } = setup();
    h.config.crmBaseUrl = "https://crm.example/api"; h.config.crmApiKey = "private-key";
    const fetcher = vi.fn().mockResolvedValue({ ok: true, json: async () => [{ instanceId: "105907", name: "line",
      isActive: true, provider: "waapi", webhookSecret: null }] });
    vi.stubGlobal("fetch", fetcher);
    h.services.instanceRegistry = new CrmInstanceRegistry(h.config);
    try {
      expect((await post(fixture())).statusCode).toBe(503);
      expect(h.scheduler.jobs).toHaveLength(0);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
      fetcher.mockResolvedValue({ ok: true, json: async () => { throw Error("private-response-secret"); } });
      const failures = await Promise.allSettled([h.services.instanceRegistry.refresh(true), h.services.instanceRegistry.refresh(true)]);
      for (const r of failures) {
        expect(r.status).toBe("rejected");
        if (r.status === "rejected") expect(r.reason.message).toBe("CRM instance registry unavailable");
      }
    } finally { await app.close(); }
  });
  it("proxy uses current per-line secret, strips media bytes and never exposes error body/url", async () => {
    const { h, app } = setup(); h.config.crmBaseUrl = "https://crm.example/api";
    const fetcher = vi.fn().mockResolvedValue({ ok: false, status: 503, text: async () => "line-secret private-content" });
    vi.stubGlobal("fetch", fetcher);
    try {
      const payload = { ...fixture(), data: { ...fixture().data, media: { data: "private-base64", mimetype: "image/jpeg" } } };
      await expect(postWebhookToCrm(h.config, "105907", payload)).rejects.toThrow("CRM webhook failed: HTTP 503");
      expect(fetcher.mock.calls[0][0]).toBe("https://crm.example/api/waapi/webhook/105907/line-secret");
      expect(JSON.parse(fetcher.mock.calls[0][1].body).data.media).toEqual({ mimetype: "image/jpeg" });
    } finally { await app.close(); }
  });
});
