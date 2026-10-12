import { describe, expect, it } from "vitest";
import { waApiWebhookSchema } from "../../src/waapi/waapi.schemas";
import { normalizeWaApiWebhook } from "../../src/webhooks/waapi.normalizer";

const message = (overrides: Record<string, unknown> = {}) => ({
  id: { _serialized: "false_99555123456@c.us_3EB0ABCDEF" },
  fromMe: false,
  from: "99555123456@c.us",
  to: "447700900123@c.us",
  type: "chat",
  body: "Да, готов сотрудничать",
  timestamp: 1_700_000_000,
  ...overrides,
});

const payload = (event: string, msg: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  event,
  instanceId: "105907",
  data: { message: msg, ...extra },
});

describe("WaAPI webhook schema", () => {
  it("requires the provider's serialized message ID", () => {
    const parsed = waApiWebhookSchema.safeParse(payload("message", {
      ...message(), id: {},
    }));
    expect(parsed.success).toBe(false);
  });

  it("rejects conflicting fromMe flags when id.fromMe is present", () => {
    const parsed = waApiWebhookSchema.safeParse(payload("message", {
      ...message({ fromMe: false }),
      id: { _serialized: "msg-1", fromMe: true },
    }));
    expect(parsed.success).toBe(false);
  });
});

describe("normalizeWaApiWebhook", () => {
  it("normalizes inbound chat text using the canonical PN and keeps the literal provider ID", () => {
    const result = normalizeWaApiWebhook("105907", payload("message", message()) as never, "99555123456@c.us");
    expect(result).toMatchObject({
      instanceId: "105907",
      idMessage: "false_99555123456@c.us_3EB0ABCDEF",
      chatId: "99555123456@c.us",
      rawChatId: "99555123456@c.us",
      senderPhone: "99555123456",
      type: "text",
      text: "Да, готов сотрудничать",
      rawType: "chat",
      timestamp: 1_700_000_000_000,
    });
  });

  it("uses the resolved PN for a private LID while retaining the raw provider chat", () => {
    const rawId = "123456789012345@lid";
    const result = normalizeWaApiWebhook("105907", payload("message", message({ from: rawId })) as never, "99555123456@c.us");
    expect(result).toMatchObject({ chatId: "99555123456@c.us", rawChatId: rawId, senderPhone: "99555123456" });
  });

  it.each([
    ["image", "image"],
    ["document", "document"],
  ] as const)("normalizes %s caption", (rawType, normalizedType) => {
    const result = normalizeWaApiWebhook("105907", payload("message", message({ type: rawType, body: "Фото/файл" })) as never, "99555123456@c.us");
    expect(result).toMatchObject({ type: normalizedType, text: "Фото/файл", rawType });
  });

  it("normalizes ptt/audio with inline media and no legacy download URL", () => {
    const media = { data: "AQID", mimetype: "audio/ogg; codecs=opus", filename: "voice.ogg", filesize: 3 };
    const result = normalizeWaApiWebhook("105907", payload("message", message({ type: "ptt", body: "" }), { media }) as never, "99555123456@c.us");
    expect(result).toMatchObject({ type: "audio", rawType: "ptt", audio: { data: "AQID", mimetype: "audio/ogg; codecs=opus", filename: "voice.ogg" } });
    expect(result?.fileUrl).toBeUndefined();
  });

  it("marks video unsupported, ignores non-message and fromMe events, and rejects groups", () => {
    expect(normalizeWaApiWebhook("105907", payload("message", message({ type: "video" })) as never, "99555123456@c.us"))
      .toMatchObject({ type: "unsupported", rawType: "video" });
    expect(normalizeWaApiWebhook("105907", payload("message_create", message()) as never, "99555123456@c.us")).toBeNull();
    expect(normalizeWaApiWebhook("105907", payload("message", message({ fromMe: true })) as never, "99555123456@c.us")).toBeNull();
    expect(normalizeWaApiWebhook("105907", payload("message", message()) as never, "120363123456789@g.us")).toBeNull();
  });
});
