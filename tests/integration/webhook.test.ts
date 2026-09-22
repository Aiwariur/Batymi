import { afterEach, describe, expect, it } from "vitest";
import { buildApp } from "../../src/app";
import { createHarness, Harness } from "../helpers/harness";
import { buildSimulatedPayload } from "../../src/webhooks/greenapi.routes";

describe("greenapi webhook routes", () => {
  let harness: Harness | undefined;

  afterEach(async () => {
    harness = undefined;
  });

  function setup() {
    harness = createHarness();
    const app = buildApp(harness.services, { redisConnected: true, workerStarted: true });
    return { app, harness };
  }

  it("returns 404 for an unknown instance", async () => {
    const { app } = setup();
    const response = await app.inject({
      method: "POST",
      url: "/webhooks/greenapi/unknown-instance",
      payload: buildSimulatedPayload({ instanceId: "unknown-instance", chatId: "1@c.us", text: "hi", idMessage: "m1" }),
    });
    expect(response.statusCode).toBe(404);
    await app.close();
  });

  it("accepts a text webhook and buffers it", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: buildSimulatedPayload({ instanceId, chatId: "995555000111@c.us", text: "Да", idMessage: "m-1" }),
    });
    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ ok: true, buffered: true });
    await app.close();
  });

  it("proxies every raw webhook to the CRM", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;

    await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: buildSimulatedPayload({ instanceId, chatId: "995555000555@c.us", text: "Да", idMessage: "m-fwd" }),
    });

    const forwarded = harness.debug.snapshot().forwardedWebhooks;
    expect(forwarded).toHaveLength(1);
    expect(forwarded[0]?.instanceId).toBe(instanceId);
    expect(forwarded[0]?.payload).toMatchObject({ typeWebhook: "incomingMessageReceived" });
    await app.close();
  });

  it("proxies delivery-status webhooks that the pipeline itself ignores", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;

    const response = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: { typeWebhook: "outgoingMessageStatus", idMessage: "x", status: "delivered" },
    });

    expect(response.json()).toMatchObject({ ok: true, ignored: true });
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(1);
    await app.close();
  });

  it("ignores duplicate webhooks", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const payload = buildSimulatedPayload({ instanceId, chatId: "995555000222@c.us", text: "Да", idMessage: "dup-2" });

    await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });
    const second = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });

    expect(second.statusCode).toBe(200);
    expect(second.json()).toMatchObject({ ok: true, ignored: true, reason: "duplicate" });
    await app.close();
  });

  it("deduplicates concurrent retries before proxying to the CRM", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const payload = buildSimulatedPayload({
      instanceId,
      chatId: "995555000223@c.us",
      text: "Да",
      idMessage: "concurrent-1",
    });

    const responses = await Promise.all([
      app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload }),
      app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload }),
    ]);

    expect(responses.map((response) => response.statusCode)).toEqual([200, 200]);
    expect(harness.scheduler.jobs).toHaveLength(1);
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(1);
    await app.close();
  });

  it("rejects group chats before buffering or proxying", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: buildSimulatedPayload({ instanceId, chatId: "120363@g.us", text: "group", idMessage: "group-1" }),
    });

    expect(response.statusCode).toBe(400);
    expect(harness.scheduler.jobs).toHaveLength(0);
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    await app.close();
  });

  it("rejects a webhook whose payload instance differs from the route", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: {
        ...buildSimulatedPayload({ instanceId, chatId: "995555000224@c.us", text: "Да", idMessage: "mismatch-1" }),
        instanceData: { idInstance: "other-instance", typeInstance: "whatsapp" },
      },
    });

    expect(response.statusCode).toBe(400);
    expect(harness.scheduler.jobs).toHaveLength(0);
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    await app.close();
  });

  it("fails closed for real webhooks with no or wrong bearer token", async () => {
    const { app, harness } = (() => {
      const realHarness = createHarness({ MOCK_GREENAPI: "false", GREENAPI_WEBHOOK_SECRET: "secret" });
      return {
        harness: realHarness,
        app: buildApp(realHarness.services, { redisConnected: true, workerStarted: true }),
      };
    })();
    const instanceId = harness.config.instances[0].id;
    const payload = buildSimulatedPayload({ instanceId, chatId: "995555000225@c.us", text: "Да", idMessage: "auth-1" });

    const missing = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });
    const wrong = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      headers: { authorization: "Bearer wrong" },
      payload,
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(harness.scheduler.jobs).toHaveLength(0);
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(0);
    await app.close();
  });

  it("allows a retry after proxy enqueue failure without losing the message", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const originalProxy = harness.services.webhookProxy;
    let attempts = 0;
    harness.services.webhookProxy = {
      async forward(id, body) {
        attempts += 1;
        if (attempts === 1) throw new Error("queue unavailable");
        await originalProxy.forward(id, body);
      },
      close: () => originalProxy.close(),
    };
    const payload = buildSimulatedPayload({ instanceId, chatId: "995555000226@c.us", text: "Да", idMessage: "retry-queue-1" });

    const first = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });
    const second = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(200);
    expect(harness.scheduler.jobs).toHaveLength(1);
    expect(harness.debug.snapshot().forwardedWebhooks).toHaveLength(1);
    await app.close();
  });

  it("allows a retry after buffer scheduling failure without duplicating the pending message", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const originalSchedule = harness.scheduler.schedule.bind(harness.scheduler);
    let attempts = 0;
    harness.scheduler.schedule = async (...args) => {
      attempts += 1;
      if (attempts === 1) throw new Error("scheduler unavailable");
      await originalSchedule(...args);
    };
    const payload = buildSimulatedPayload({ instanceId, chatId: "995555000227@c.us", text: "Да", idMessage: "retry-buffer-1" });

    const first = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });
    const second = await app.inject({ method: "POST", url: `/webhooks/greenapi/${instanceId}`, payload });

    expect(first.statusCode).toBe(503);
    expect(second.statusCode).toBe(200);
    expect(harness.scheduler.jobs).toHaveLength(1);
    await harness.scheduler.runAll();
    expect(harness.llm.calls).toHaveLength(1);
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
    await app.close();
  });

  it("ignores non incoming webhooks", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const response = await app.inject({
      method: "POST",
      url: `/webhooks/greenapi/${instanceId}`,
      payload: { typeWebhook: "outgoingMessageStatus", idMessage: "x" },
    });
    expect(response.json()).toMatchObject({ ok: true, ignored: true });
    await app.close();
  });

  it("exposes health endpoints", async () => {
    const { app } = setup();
    const live = await app.inject({ method: "GET", url: "/health/live" });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(live.json()).toEqual({ ok: true });
    expect(ready.json()).toMatchObject({ ok: true, redis: "ok", worker: "ok" });
    await app.close();
  });

  it("is ready with instance ids and no GreenAPI send tokens", async () => {
    const harness = createHarness({
      MOCK_EXTERNALS: "false",
      MOCK_CRM: "true",
      MOCK_LLM: "true",
      MOCK_GREENAPI: "false",
      GREENAPI_INSTANCE_1_ID: "id-only-instance",
      GREENAPI_WEBHOOK_SECRET: "secret",
    });
    const app = buildApp(harness.services, { redisConnected: true, workerStarted: true });
    const ready = await app.inject({ method: "GET", url: "/health/ready" });
    expect(ready.statusCode).toBe(200);
    expect(ready.json()).toMatchObject({ ok: true, instances: 1 });
    await app.close();
  });

  it("runs the debug simulator through the same pipeline", async () => {
    const { app, harness } = setup();
    const instanceId = harness.config.instances[0].id;
    const response = await app.inject({
      method: "POST",
      url: "/debug/simulate-message",
      payload: { instanceId, chatId: "995555000333@c.us", text: "Да, я собственник" },
    });
    expect(response.json()).toMatchObject({ ok: true, buffered: true });
    expect(harness.scheduler.jobs.length).toBe(1);
    await app.close();
  });
});

describe("audio pipeline", () => {
  it("transcribes audio and feeds the transcript into the batch", async () => {
    const harness = createHarness();
    const instanceId = harness.config.instances[0].id;
    await harness.ingest(
      harness.makeMessage({
        instanceId,
        chatId: "995555000444@c.us",
        type: "audio",
        fileUrl: "https://greenapi.example/audio.ogg",
        text: undefined,
        rawType: "audioMessage",
      }),
    );

    await harness.scheduler.runAll();

    expect(harness.llm.calls.length).toBe(1);
    expect(harness.llm.lastUserText()).toContain("собственник");
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
  });
});
