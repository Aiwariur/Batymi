import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { CrmInteraction } from "../../src/crm/crm.client";

describe("CRM and local conversation history recovery", () => {
  it("keeps a prior audio transcript in the next model turn after CRM proxy delivery", async () => {
    const h = createHarness();
    const instanceId = h.config.instances[0].id;
    const phone = "+995555700090";
    const chatId = `${phone.slice(1)}@c.us`;
    h.crm.setContactState(phone, { status: "new", listings: [{ id: 101, address: "Кобаладзе 12" }] as never });
    const audioRow: CrmInteraction = {
      id: 1, direction: "incoming", sender: null, instance_id: instanceId,
      sent_at: new Date().toISOString(), text: "🎵 Аудио", message_id: "voice-1",
    };
    vi.spyOn(h.services.crm, "getInteractions")
      .mockResolvedValueOnce([]).mockResolvedValueOnce([])
      .mockResolvedValue([audioRow]);
    vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Квартира на Кобаладзе 12, готов сотрудничать");

    await h.ingest({ ...h.makeMessage({ instanceId, chatId, text: "" }), idMessage: "voice-1", type: "audio", rawType: "audioMessage", text: undefined, fileUrl: "https://greenapi.example/voice.ogg" });
    await h.scheduler.runAll();
    await h.ingest(h.makeMessage({ instanceId, chatId, text: "Да, всё верно" }));
    await h.scheduler.runAll();

    expect(h.llm.calls).toHaveLength(2);
    expect(h.llm.calls[1].some(message => message.role === "user" && message.content.includes("Квартира на Кобаладзе 12, готов сотрудничать"))).toBe(true);
  });

  it("stops before the model when a human phone reply follows agent outreach", async () => {
    const h = createHarness();
    const instanceId = h.config.instances[0].id;
    const phone = "+995555700091";
    const chatId = `${phone.slice(1)}@c.us`;
    h.crm.setContactState(phone, { status: "new", listings: [{ id: 102, address: "Лермонтова 31" }] as never });
    vi.spyOn(h.services.crm, "getInteractions").mockResolvedValue([
      { id: 1, direction: "outgoing", sender: "agent", instance_id: instanceId, sent_at: "2026-10-10T08:00:00Z", text: "Готовы сотрудничать?" },
      { id: 2, direction: "outgoing", sender: "phone", instance_id: instanceId, sent_at: "2026-10-10T08:01:00Z", text: "Дальше отвечаю лично" },
    ]);

    await h.ingest(h.makeMessage({ instanceId, chatId, text: "Какую квартиру имеете в виду?" }));
    expect((await h.scheduler.runAll())[0]).toMatchObject({ status: "skipped" });
    expect(h.llm.calls).toHaveLength(0);
    expect(h.debug.snapshot().outgoing).toHaveLength(0);
  });
});
