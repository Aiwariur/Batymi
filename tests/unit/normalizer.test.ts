import { describe, expect, it } from "vitest";
import { normalizeGreenApiWebhook, phoneFromChatId } from "../../src/webhooks/greenapi.normalizer";
import { GreenApiWebhookPayload } from "../../src/greenapi/greenapi.schemas";

const basePayload = {
  typeWebhook: "incomingMessageReceived",
  idMessage: "msg-1",
  timestamp: 1700000000,
  instanceData: { idInstance: 7107577616, typeInstance: "whatsapp" },
  senderData: { chatId: "995555123456@c.us", chatName: "Owner" },
};

describe("normalizeGreenApiWebhook", () => {
  it("normalizes a text message", () => {
    const payload = {
      ...basePayload,
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "Да, продаётся" } },
    } as GreenApiWebhookPayload;

    const result = normalizeGreenApiWebhook("7107577616", payload);
    expect(result).not.toBeNull();
    expect(result).toMatchObject({
      instanceId: "7107577616",
      idMessage: "msg-1",
      chatId: "995555123456@c.us",
      senderPhone: "995555123456",
      type: "text",
      text: "Да, продаётся",
      rawType: "textMessage",
    });
  });

  it("normalizes an audio message and keeps the download url", () => {
    const payload = {
      ...basePayload,
      messageData: {
        typeMessage: "audioMessage",
        fileMessageData: { downloadUrl: "https://greenapi.example/audio.ogg" },
      },
    } as GreenApiWebhookPayload;

    const result = normalizeGreenApiWebhook("7107577616", payload);
    expect(result).toMatchObject({
      type: "audio",
      fileUrl: "https://greenapi.example/audio.ogg",
    });
    expect(result?.text).toBeUndefined();
  });

  it("marks unknown message types as unsupported", () => {
    const payload = {
      ...basePayload,
      messageData: { typeMessage: "locationMessage" },
    } as GreenApiWebhookPayload;

    const result = normalizeGreenApiWebhook("7107577616", payload);
    expect(result).toMatchObject({ type: "unsupported", rawType: "locationMessage" });
  });

  it("ignores non incoming webhooks", () => {
    const payload = { ...basePayload, typeWebhook: "outgoingMessageStatus" } as GreenApiWebhookPayload;
    expect(normalizeGreenApiWebhook("7107577616", payload)).toBeNull();
  });

  it("ignores payloads without idMessage", () => {
    const payload = {
      typeWebhook: "incomingMessageReceived",
      senderData: { chatId: "995555123456@c.us" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "hi" } },
    } as GreenApiWebhookPayload;
    expect(normalizeGreenApiWebhook("7107577616", payload)).toBeNull();
  });

  it("rejects group chat ids instead of treating them as owner phones", () => {
    const payload = {
      ...basePayload,
      senderData: { chatId: "120363123456789@g.us" },
      messageData: { typeMessage: "textMessage", textMessageData: { textMessage: "hi" } },
    } as GreenApiWebhookPayload;
    expect(normalizeGreenApiWebhook("7107577616", payload)).toBeNull();
  });
});

describe("phoneFromChatId", () => {
  it("extracts digits from a chat id", () => {
    expect(phoneFromChatId("995555123456@c.us")).toBe("995555123456");
  });
});
