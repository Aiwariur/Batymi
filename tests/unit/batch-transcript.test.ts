import { describe, expect, it, vi } from "vitest";
import { resolveBatchText } from "../../src/conversation/conversation.service";
import type { NormalizedMessage } from "../../src/types";

function audioMessage(): NormalizedMessage {
  return {
    instanceId: "710722742102",
    idMessage: "audio-1",
    chatId: "995599123456@c.us",
    senderPhone: "+995599123456",
    type: "audio",
    fileUrl: "https://files.example/voice.ogg",
    timestamp: 1700000000,
    rawType: "audioMessage",
  };
}

function services(overrides: Record<string, unknown> = {}) {
  return {
    transcription: { transcribe: vi.fn().mockResolvedValue("Квартира ещё сдаётся") },
    crm: { pushTranscript: vi.fn().mockResolvedValue(undefined) },
    logger: { warn: vi.fn(), debug: vi.fn(), info: vi.fn() },
    ...overrides,
  };
}

describe("resolveBatchText audio transcripts", () => {
  it("pushes the transcript to CRM keyed by instance and message id", async () => {
    const message = audioMessage();
    const svc = services();

    const batchText = await resolveBatchText([message], svc as never);

    expect(batchText).toBe("Квартира ещё сдаётся");
    expect(message.text).toBe("Квартира ещё сдаётся");
    expect(svc.crm.pushTranscript).toHaveBeenCalledWith({
      instanceId: "710722742102",
      messageId: "audio-1",
      text: "Квартира ещё сдаётся",
    });
  });

  it("keeps the batch alive when the CRM transcript push fails", async () => {
    const svc = services({
      crm: { pushTranscript: vi.fn().mockRejectedValue(new Error("crm down")) },
    });

    const batchText = await resolveBatchText([audioMessage()], svc as never);

    expect(batchText).toBe("Квартира ещё сдаётся");
  });

  it("does not push anything when transcription yields no text", async () => {
    const svc = services({
      transcription: { transcribe: vi.fn().mockResolvedValue("") },
    });

    const batchText = await resolveBatchText([audioMessage()], svc as never);

    expect(batchText).toBe("");
    expect(svc.crm.pushTranscript).not.toHaveBeenCalled();
  });
});
