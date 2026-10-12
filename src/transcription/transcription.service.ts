import { Config } from "../config/env";
import { Logger } from "../observability/logger";

export type InlineAudioInput = ({ base64: string } | { data: string }) & { mimetype: string; filename?: string };
export type AudioInput = string | InlineAudioInput;
export interface TranscriptionService { transcribe(input: AudioInput): Promise<string>; }

/** Permanent input errors contain no source data, filenames or URLs. */
export class AudioInputError extends Error {}

const AUDIO_EXTENSIONS: Record<string, string> = {
  "audio/ogg": "ogg", "audio/opus": "ogg", "audio/mpeg": "mp3", "audio/mp3": "mp3",
  "audio/mp4": "m4a", "audio/x-m4a": "m4a", "audio/wav": "wav", "audio/x-wav": "wav",
  "audio/webm": "webm", "audio/flac": "flac", "audio/x-flac": "flac",
};

const inlineBase64 = (input: InlineAudioInput): string => "base64" in input ? input.base64 : input.data;

export function validateInlineAudio(input: InlineAudioInput, maxBytes: number): { mime: string; extension: string } {
  const mime = input.mimetype.trim().toLowerCase();
  const extension = AUDIO_EXTENSIONS[mime.split(";", 1)[0].trim()];
  if (!extension || mime.length > 200 || /[\r\n]/.test(mime)) throw new AudioInputError("unsupported audio MIME");
  const data = inlineBase64(input);
  if (data.length > 4 * Math.ceil(maxBytes / 3)) throw new AudioInputError("audio exceeds byte limit");
  if (!data || data.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(data))
    throw new AudioInputError("invalid audio base64");
  const padding = data.endsWith("==") ? 2 : data.endsWith("=") ? 1 : 0;
  const size = data.length / 4 * 3 - padding;
  if (size <= 0) throw new AudioInputError("invalid audio base64");
  if (size > maxBytes) throw new AudioInputError("audio exceeds byte limit");
  // Check unused bits as well: Node's permissive decoder accepts noncanonical input.
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
  if (padding && (alphabet.indexOf(data[data.length - padding - 1]) & (padding === 2 ? 15 : 3)))
    throw new AudioInputError("invalid audio base64");
  return { mime, extension };
}

const DOWNLOAD_TIMEOUT_MS = 30000;
const TRANSCRIBE_TIMEOUT_MS = 60000;

export class OpenAiTranscriptionService implements TranscriptionService {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async transcribe(input: AudioInput): Promise<string> {
    if (!this.config.llmApiKey) throw new Error("LLM_API_KEY is required for transcription");
    let bytes: Uint8Array;
    let mime = "audio/ogg", extension = "ogg";
    if (typeof input === "string") bytes = await this.download(input);
    else {
      ({ mime, extension } = validateInlineAudio(input, this.config.audioMaxBytes));
      bytes = Buffer.from(inlineBase64(input), "base64");
    }
    const form = new FormData();
    // Never trust or log a provider filename. MIME determines the safe local name.
    form.append("file", new Blob([bytes as Uint8Array<ArrayBuffer>], { type: mime }), `audio.${extension}`);
    form.append("model", this.config.transcriptionModel);

    const transcribeController = new AbortController();
    const transcribeTimer = setTimeout(() => transcribeController.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.config.llmBaseUrl}/audio/transcriptions`, {
        method: "POST", headers: { Authorization: `Bearer ${this.config.llmApiKey}` },
        body: form, signal: transcribeController.signal,
      });
      if (response.status === 413) throw new AudioInputError("audio exceeds transcription byte limit");
      if (!response.ok) throw new Error(`transcription failed: HTTP ${response.status}`);
      const data = (await response.json()) as { text?: string };
      return (data.text ?? "").trim();
    } catch (error) {
      if (error instanceof AudioInputError || error instanceof Error && /^transcription failed: HTTP \d+$/.test(error.message)) throw error;
      throw new Error("transcription request unavailable");
    } finally { clearTimeout(transcribeTimer); }
  }

  private async download(fileUrl: string): Promise<Uint8Array> {
    const downloadController = new AbortController();
    const downloadTimer = setTimeout(() => downloadController.abort(), DOWNLOAD_TIMEOUT_MS);
    try {
      const response = await fetch(fileUrl, { signal: downloadController.signal });
      if (!response.ok) throw new Error(`audio download failed: HTTP ${response.status}`);
      if (Number(response.headers.get("content-length")) > this.config.audioMaxBytes) {
        await response.body?.cancel();
        throw new AudioInputError("audio exceeds byte limit");
      }
      if (!response.body) throw new AudioInputError("empty audio download");
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          total += value.byteLength;
          if (total > this.config.audioMaxBytes) { await reader.cancel(); throw new AudioInputError("audio exceeds byte limit"); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      if (!total) throw new AudioInputError("empty audio download");
      return Buffer.concat(chunks, total);
    } catch (error) {
      if (error instanceof AudioInputError || error instanceof Error && /^audio download failed: HTTP \d+$/.test(error.message)) throw error;
      throw new Error("audio download unavailable");
    } finally { clearTimeout(downloadTimer); }
  }
}

export class MockTranscriptionService implements TranscriptionService {
  constructor(private readonly logger: Logger) {}

  async transcribe(_input: AudioInput): Promise<string> {
    this.logger.debug("transcription.mocked");
    return "Да, я собственник, можно работать";
  }
}

export function createTranscriptionService(
  config: Config,
  logger: Logger,
): TranscriptionService {
  return config.mockTranscription
    ? new MockTranscriptionService(logger)
    : new OpenAiTranscriptionService(config, logger);
}
