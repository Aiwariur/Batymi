import { Config } from "../config/env";
import { Logger } from "../observability/logger";

export interface TranscriptionService {
  transcribe(fileUrl: string): Promise<string>;
}

const DOWNLOAD_TIMEOUT_MS = 30000;
const TRANSCRIBE_TIMEOUT_MS = 60000;

export class OpenAiTranscriptionService implements TranscriptionService {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async transcribe(fileUrl: string): Promise<string> {
    if (!this.config.llmApiKey) throw new Error("LLM_API_KEY is required for transcription");

    const downloadController = new AbortController();
    const downloadTimer = setTimeout(() => downloadController.abort(), DOWNLOAD_TIMEOUT_MS);
    let audio: ArrayBuffer;
    try {
      const response = await fetch(fileUrl, { signal: downloadController.signal });
      if (!response.ok) throw new Error(`audio download failed: HTTP ${response.status}`);
      audio = await response.arrayBuffer();
    } finally {
      clearTimeout(downloadTimer);
    }

    const form = new FormData();
    form.append("file", new Blob([audio]), "audio.ogg");
    form.append("model", this.config.transcriptionModel);

    const transcribeController = new AbortController();
    const transcribeTimer = setTimeout(() => transcribeController.abort(), TRANSCRIBE_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.config.llmBaseUrl}/audio/transcriptions`, {
        method: "POST",
        headers: { Authorization: `Bearer ${this.config.llmApiKey}` },
        body: form,
        signal: transcribeController.signal,
      });
      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`transcription failed: HTTP ${response.status} ${body.slice(0, 200)}`);
      }
      const data = (await response.json()) as { text?: string };
      return (data.text ?? "").trim();
    } finally {
      clearTimeout(transcribeTimer);
    }
  }
}

export class MockTranscriptionService implements TranscriptionService {
  constructor(private readonly logger: Logger) {}

  async transcribe(fileUrl: string): Promise<string> {
    this.logger.debug({ fileUrl }, "transcription.mocked");
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
