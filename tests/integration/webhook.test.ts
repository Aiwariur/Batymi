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
