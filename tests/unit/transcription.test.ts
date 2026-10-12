import { afterEach, describe, expect, it, vi } from "vitest";
import { Config } from "../../src/config/env";
import { Logger } from "../../src/observability/logger";
import { AudioInputError, OpenAiTranscriptionService } from "../../src/transcription/transcription.service";

const MAX_AUDIO_BYTES = 20 * 1024 * 1024;
const bytes = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 0x01, 0x02]);

function makeService(audioMaxBytes = MAX_AUDIO_BYTES) {
  const config = {
    llmApiKey: "test-key",
    llmBaseUrl: "https://llm.example/v1",
    transcriptionModel: "whisper-1",
    audioMaxBytes,
  } as Config;
  const logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() } as unknown as Logger;
  return { service: new OpenAiTranscriptionService(config, logger), logger };
}

function transcriptionResponse(text = " расшифровка ") {
  return new Response(JSON.stringify({ text }), { status: 200, headers: { "content-type": "application/json" } });
}

afterEach(() => vi.unstubAllGlobals());

describe("OpenAiTranscriptionService inline audio", () => {
  it("sends inline OGG/Opus bytes directly as multipart without downloading a URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(transcriptionResponse());
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService();

    const text = await service.transcribe({
      data: Buffer.from(bytes).toString("base64"),
      mimetype: "audio/ogg; codecs=opus",
      filename: "../../private-owner-recording.ogg",
    });

    expect(text).toBe("расшифровка");
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("https://llm.example/v1/audio/transcriptions");
    const request = fetchMock.mock.calls[0][1] as RequestInit;
    expect(request.method).toBe("POST");
    expect(new Headers(request.headers).get("authorization")).toBe("Bearer test-key");
    expect(request.body).toBeInstanceOf(FormData);
    const form = request.body as FormData;
    expect(form.get("model")).toBe("whisper-1");
    const file = form.get("file") as File;
    expect(file.name).toBe("audio.ogg");
    expect(file.type).toBe("audio/ogg; codecs=opus");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
  });

  it("accepts omitted filename and derives a usable OGG filename", async () => {
    const fetchMock = vi.fn().mockResolvedValue(transcriptionResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService();

    await service.transcribe({ data: Buffer.from(bytes).toString("base64"), mimetype: "audio/ogg; codecs=opus" });

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const file = ((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get("file") as File;
    expect(file.name).toMatch(/\.ogg$/i);
  });

  it.each(["", "not base64?", "AQ===", "AQID=", "AB==", "AAB="])("rejects malformed or empty inline base64 (%j) before network access", async data => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService();

    await expect(service.transcribe({ data, mimetype: "audio/ogg; codecs=opus" })).rejects.toBeInstanceOf(AudioInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
  it("accepts the explicit base64/mimetype input API", async () => {
    const fetchMock = vi.fn().mockResolvedValue(transcriptionResponse("ok"));
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService();
    expect(await service.transcribe({ base64: Buffer.from(bytes).toString("base64"), mimetype: "audio/ogg" })).toBe("ok");
    const file = ((fetchMock.mock.calls[0][1] as RequestInit).body as FormData).get("file") as File;
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([...bytes]);
  });

  it("rejects non-audio MIME types before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService();

    await expect(service.transcribe({ data: Buffer.from(bytes).toString("base64"), mimetype: "image/png" }))
      .rejects.toBeInstanceOf(AudioInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects decoded inline audio above the 20 MiB cap before network access", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(5);
    const data = Buffer.alloc(6).toString("base64");

    await expect(service.transcribe({ data, mimetype: "audio/ogg; codecs=opus" })).rejects.toBeInstanceOf(AudioInputError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("bounds legacy URL downloads before forwarding audio to transcription", async () => {
    const fetchMock = vi.fn().mockResolvedValue(new Response(new ReadableStream({
      start(controller) {
        controller.enqueue(Uint8Array.from([1, 2, 3, 4, 5, 6]));
        controller.close();
      },
    }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const { service } = makeService(5);

    await expect(service.transcribe("https://provider.example/audio.ogg")).rejects.toBeInstanceOf(AudioInputError);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("does not expose media data or provider error content in logs and errors", async () => {
    const secretAudio = "SUPER_SECRET_PRIVATE_AUDIO";
    const fetchMock = vi.fn().mockResolvedValue(new Response("provider leaked payload", { status: 413 }));
    vi.stubGlobal("fetch", fetchMock);
    const { service, logger } = makeService();

    let error: unknown;
    try {
      await service.transcribe({ data: Buffer.from(secretAudio).toString("base64"), mimetype: "audio/ogg" });
    } catch (caught) {
      error = caught;
    }

    expect(error).toBeInstanceOf(AudioInputError);
    expect((error as Error).message).not.toContain(secretAudio);
    expect((error as Error).message).not.toContain("provider leaked payload");
    expect(JSON.stringify(logger)).not.toContain(secretAudio);
    expect(JSON.stringify(logger)).not.toContain(Buffer.from(secretAudio).toString("base64"));
  });
});
