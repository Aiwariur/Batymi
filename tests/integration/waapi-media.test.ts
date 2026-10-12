import { afterEach, describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { createHarness } from "../helpers/harness";
import { stripWaApiMedia } from "../../src/crm/webhook-proxy";
import { MemoryConversationStore } from "../../src/buffer/memory-store";

const phone = "995555123456@c.us";
const fixture = (type = "ptt", caption = "", data = "T2dnUw==") => ({
  event: "message", instanceId: "105907", data: { message: {
    id: { _serialized: `false_${phone}_${type}` }, fromMe: false, from: phone,
    type, body: caption, timestamp: 1791705600, hasMedia: true,
  }, media: { data, mimetype: type === "ptt" ? "audio/ogg; codecs=opus" : "video/mp4" } },
});
const setup = (env: Record<string, string> = {}) => {
  const h = createHarness({ WAAPI_INSTANCE_ID: "105907", WAAPI_WEBHOOK_SECRET: "media-secret", OWNER_DIALOGUE_MODE: "cooperation_only", ...env });
  h.crm.setContactState(phone, { status: "new", listings: [{ id: 101, address: "Synthetic address" }] as never });
  h.llm.responder = () => JSON.stringify({ intent: "identify", language: "ru" });
  const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
  const post = (payload: unknown) => app.inject({ method: "POST", url: "/webhooks/waapi/105907/media-secret", payload: JSON.stringify(payload), headers: { "content-type": "application/json" } });
  return { h, app, post };
};
afterEach(() => vi.restoreAllMocks());
describe("WaAPI inline media stage 7", () => {
  it("feeds inline ptt to the existing transcriber/model and keeps only transcript in history", async () => {
    const { h, app, post } = setup();
    const transcribe = vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Кто мне пишет?");
    try {
      expect((await post(fixture())).statusCode).toBe(200);
      await h.scheduler.runAll();
      expect(transcribe).toHaveBeenCalledWith({ data: "T2dnUw==", mimetype: "audio/ogg; codecs=opus" });
      expect(h.llm.lastUserText()).toBe("Кто мне пишет?");
      const history = JSON.stringify(await h.store.getHistory(h.key("105907", phone), 20));
      expect(history).toContain("Кто мне пишет?");
      expect(history).not.toContain("T2dnUw==");
    } finally { await app.close(); }
  });
  it.each(["identity", "terms", "manager_takeover"])("silences paused %s text/audio without transcription, LLM, sends or CRM actions", async reason => {
    const { h, app, post } = setup();
    const key = h.key("105907", phone);
    await h.ingest(h.makeMessage({ instanceId: "105907", chatId: phone, text: "initial" }));
    await h.store.drainPending(key);
    const active = await h.store.getActiveBatch(key);
    const lock = await h.store.acquireLock(key, 10000);
    await h.store.handoffToManager(key, active!.batchKey, reason, lock!.token);
    await h.store.releaseLock(key, lock!.token);
    h.scheduler.take();
    const transcribe = vi.spyOn(h.services.transcription, "transcribe");
    const getListings = vi.spyOn(h.crm, "getListingsByPhone");
    try {
      await post(fixture());
      await post(fixture("chat", "После паузы"));
      await h.scheduler.runAll();
      expect(transcribe).not.toHaveBeenCalled();
      expect(getListings).not.toHaveBeenCalled();
      expect(h.llm.calls).toHaveLength(0);
      expect(h.debug.snapshot().outgoing).toHaveLength(0);
      expect(h.debug.snapshot().crmActions).toHaveLength(0);
      expect(await h.store.getActiveBatch(key)).toBeNull();
    } finally { await app.close(); }
  });
  it.each(["image", "video", "document"])("keeps %s caption/no-caption metadata and drops blobs before durable forwarding", async type => {
    const { h, app, post } = setup();
    const forward = vi.fn().mockResolvedValue(undefined);
    h.services.webhookProxy = { handlesWaApiIngress: true, forward, close: async () => {} };
    try {
      for (const caption of ["Подпись", ""]) {
        expect((await post(fixture(type, caption, "PRIVATE_BLOB"))).statusCode).toBe(200);
        const forwarded = forward.mock.calls.at(-1)![1];
        expect(JSON.stringify(forwarded)).not.toContain("PRIVATE_BLOB");
        expect(forwarded.data.message.body).toBe(caption);
      }
    } finally { await app.close(); }
  });
  it("rejects invalid inline audio before durable enqueue", async () => {
    const { h, app, post } = setup();
    try {
      expect((await post(fixture("ptt", "", "%%%"))).statusCode).toBe(400);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("ignores group/status audio without retaining or validating an irrelevant blob", async () => {
    const { h, app, post } = setup();
    const forward = vi.fn().mockResolvedValue(undefined);
    h.services.webhookProxy = { handlesWaApiIngress: true, forward, close: async () => {} };
    try {
      for (const extra of [{ isStatus: true }, { isGroupMsg: true }, { from: "123@g.us" }]) {
        const payload = fixture("ptt", "", "PRIVATE_BLOB");
        Object.assign(payload.data.message, extra);
        expect((await post(payload)).statusCode).toBe(200);
        expect(JSON.stringify(forward.mock.calls.at(-1)![1])).not.toContain("PRIVATE_BLOB");
      }
    } finally { await app.close(); }
  });
  it("rejects audio above the configured decoded limit without enqueue or model use", async () => {
    const { h, app, post } = setup({ AUDIO_MAX_BYTES: "3" });
    try {
      expect((await post(fixture())).statusCode).toBe(413);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
      expect(h.llm.calls).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("accepts a synthetic 20 MiB video JSON through ingress but retains only metadata", async () => {
    const { h, app, post } = setup();
    const data = Buffer.alloc(20 * 1024 * 1024, 65).toString("base64");
    try {
      expect((await post(fixture("video", "Большое видео", data))).statusCode).toBe(200);
      expect(JSON.stringify(h.debug.snapshot().forwardedWebhooks).length).toBeLessThan(2000);
      expect(h.llm.calls).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("rejects a synthetic video above the default full-JSON cap", async () => {
    const { h, app, post } = setup();
    const data = Buffer.alloc(25 * 1024 * 1024).toString("base64");
    try {
      expect((await post(fixture("video", "", data))).statusCode).toBe(413);
      expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    } finally { await app.close(); }
  });
  it("enforces exact complete-JSON byte boundaries with safe 413 before forwarding", async () => {
    const payload = fixture("video", "", "AAAA");
    const bytes = Buffer.byteLength(JSON.stringify(payload));
    for (const [limit, status] of [[bytes, 200], [bytes - 1, 413]]) {
      const { h, app, post } = setup({ WHATSAPP_WEBHOOK_BODY_LIMIT_BYTES: String(limit) });
      try {
        expect((await post(payload)).statusCode).toBe(status);
        if (status === 413) expect(h.debug.snapshot().forwardedWebhooks).toHaveLength(0);
      } finally { await app.close(); }
    }
  });
  it("strips nested raw blobs from repeated CRM proxy payloads", () => {
    const payload = fixture("image", "caption");
    const extra = { ...payload, data: { ...payload.data, unexpected: { data: "PRIVATE_BLOB" }, _data: { body: "PRIVATE_BLOB" } } };
    expect(JSON.stringify(stripWaApiMedia(extra))).not.toContain("PRIVATE_BLOB");
  });
  it("bounds pending serialized bytes before dedup commit and accepts retry after draining", async () => {
    const store = new MemoryConversationStore();
    const { h, app } = setup();
    try {
      const message = { ...h.makeMessage({ instanceId: "105907", chatId: phone }), audio: { data: "T2dnUw==", mimetype: "audio/ogg" } };
      const maxPendingBytes = Buffer.byteLength(JSON.stringify(message));
      const input = { instanceId: "105907", idMessage: "first", conversationKey: "cap-test", message, token: "token", idempotencyTtlSeconds: 60, debounceTtlMs: 60, maxPendingBytes };
      expect(await store.acceptInbound(input)).toBe(true);
      await expect(store.acceptInbound({ ...input, idMessage: "second" })).rejects.toThrow("conversation buffer exceeds byte limit");
      await store.drainPending("cap-test");
      expect(await store.acceptInbound({ ...input, idMessage: "second" })).toBe(true);
    } finally { await app.close(); }
  });
});
