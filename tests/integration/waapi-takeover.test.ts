import { describe, expect, it, vi } from "vitest";
import { buildApp } from "../../src/app";
import { CrmInteraction } from "../../src/crm/crm.client";
import { createHarness } from "../helpers/harness";

const instanceId = "105907";
const phone = "+995555123456";
const chatId = "995555123456@c.us";

function setup(ownerDialogueMode: "full" | "cooperation_only" = "full") {
  const h = createHarness({ WAAPI_INSTANCE_ID: instanceId, WAAPI_WEBHOOK_SECRET: "test-line-secret", OWNER_DIALOGUE_MODE: ownerDialogueMode });
  h.crm.setContactState(phone, { status: "sent" });
  const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
  const post = (id: string) => app.inject({ method: "POST", url: `/webhooks/waapi/${instanceId}/test-line-secret`, payload: {
    event: "message", instanceId, data: { message: {
      id: { _serialized: `false_${chatId}_${id}`, fromMe: false }, fromMe: false, from: chatId,
      type: "chat", body: "Да, готов сотрудничать", timestamp: Math.floor(Date.now() / 1000),
    } },
  } });
  return { h, app, post };
}

function outgoing(sender: "phone" | "manager" | "agent"): CrmInteraction {
  return { id: `out-${sender}`, direction: "outgoing", sender, instance_id: instanceId,
    sent_at: new Date().toISOString(), text: `Ответ ${sender}`, message_id: `out-${sender}` };
}

describe("WaAPI CRM history takeover", () => {
  it.each(["phone", "manager"] as const)("stops a queued batch for a %s interaction before the model", async (sender) => {
    const { h, app, post } = setup("cooperation_only");
    vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([outgoing(sender)]);
    try {
      expect((await post(`queued-${sender}`)).statusCode).toBe(200);
      const result = await h.scheduler.runAll();
      expect(result[0]).toMatchObject({ status: "skipped" });
      expect(h.llm.calls).toHaveLength(0);
      expect(h.debug.snapshot().outgoing).toHaveLength(0);
    } finally { await app.close(); }
  });

  it.each(["phone", "manager"] as const)("stops a stale reply when a %s interaction arrives while the model is running", async (sender) => {
    const { h, app, post } = setup();
    vi.spyOn(h.services.crm, "getInteractions")
      .mockResolvedValueOnce([])
      .mockResolvedValue([outgoing(sender)]);
    try {
      expect((await post(`stale-${sender}`)).statusCode).toBe(200);
      await h.scheduler.runAll();
      expect(h.llm.calls).toHaveLength(1);
      expect(h.debug.snapshot().outgoing).toHaveLength(0);
    } finally { await app.close(); }
  });

  it("does not treat an own API echo as takeover", async () => {
    const { h, app, post } = setup();
    vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([outgoing("agent")]);
    try {
      const echo = await app.inject({ method: "POST", url: `/webhooks/waapi/${instanceId}/test-line-secret`, payload: {
        event: "message_create", instanceId, data: { message: {
          id: { _serialized: `true_${chatId}_api-echo`, fromMe: true }, fromMe: true,
          from: chatId, to: chatId, type: "chat", body: "Бот ответил", timestamp: Math.floor(Date.now() / 1000),
        } },
      } });
      expect(echo.statusCode).toBe(200);
      expect(echo.json()).toMatchObject({ ignored: true });
      expect((await post("after-own-echo")).statusCode).toBe(200);
      await h.scheduler.runAll();
      expect(h.llm.calls).toHaveLength(1);
      expect(h.debug.snapshot().outgoing).toHaveLength(1);
    } finally { await app.close(); }
  });

  it("does not let an own API echo stop a cooperation_only semantic_v3 reply", async () => {
    const { h, app, post } = setup("cooperation_only");
    vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([outgoing("agent")]);
    h.llm.responder = () => JSON.stringify({ intent: "ask_cooperation", language: "ru" });
    try {
      const echo = await app.inject({ method: "POST", url: `/webhooks/waapi/${instanceId}/test-line-secret`, payload: {
        event: "message_create", instanceId, data: { message: {
          id: { _serialized: `true_${chatId}_cooperation-api-echo`, fromMe: true }, fromMe: true,
          from: chatId, to: chatId, type: "chat", body: "Ваша квартира ещё актуальна?", timestamp: Math.floor(Date.now() / 1000),
        } },
      } });
      expect(echo.statusCode).toBe(200);
      expect((await post("cooperation-after-echo")).statusCode).toBe(200);
      await h.scheduler.runAll();
      expect(h.llm.calls).toHaveLength(1);
      expect(h.debug.snapshot().outgoing).toHaveLength(1);
    } finally { await app.close(); }
  });
});
