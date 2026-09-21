import { Config, loadConfig } from "../../src/config/env";
import { createLogger } from "../../src/observability/logger";
import { InMemoryDebugRecorder } from "../../src/observability/debug-recorder";
import { MemoryConversationStore } from "../../src/buffer/memory-store";
import { Services } from "../../src/services";
import { ConversationScheduler } from "../../src/queue/conversation.queue";
import { createCrmClient, MockCrmClient } from "../../src/crm/crm.client";
import { createMessageSender } from "../../src/crm/reply.sender";
import { MockWebhookProxy } from "../../src/crm/webhook-proxy";
import { createTranscriptionService } from "../../src/transcription/transcription.service";
import { ChatMessage, LlmProvider } from "../../src/agent/llm.provider";
import { handleConversationJob, RunOutcome } from "../../src/conversation/conversation.service";
import { ingestMessage, IngestResult } from "../../src/buffer/message-buffer";
import { conversationKey } from "../../src/buffer/keys";
import { NormalizedMessage } from "../../src/types";

export interface ScheduledJob {
  conversationKey: string;
  token: string;
  delayMs: number;
  retryCount: number;
}

export class TestScheduler implements ConversationScheduler {
  jobs: ScheduledJob[] = [];
  private runner: (job: ScheduledJob) => Promise<RunOutcome> = async () => ({ status: "empty", runId: "noop" });

  setRunner(runner: (job: ScheduledJob) => Promise<RunOutcome>): void {
    this.runner = runner;
  }

  async schedule(
    conversationKey: string,
    token: string,
    delayMs: number,
    retryCount = 0,
  ): Promise<void> {
    this.jobs.push({ conversationKey, token, delayMs, retryCount });
  }

  async close(): Promise<void> {
    this.jobs = [];
  }

  take(): ScheduledJob[] {
    const current = this.jobs;
    this.jobs = [];
    return current;
  }

  async runNext(): Promise<RunOutcome | undefined> {
    const job = this.jobs.shift();
    if (!job) return undefined;
    return this.runner(job);
  }

  async runAll(): Promise<RunOutcome[]> {
    const results: RunOutcome[] = [];
    for (let guard = 0; guard < 1000; guard += 1) {
      const batch = this.take();
      if (batch.length === 0) break;
      for (const job of batch) results.push(await this.runner(job));
    }
    return results;
  }

  async runAllParallel(): Promise<RunOutcome[]> {
    const results: RunOutcome[] = [];
    for (let guard = 0; guard < 1000; guard += 1) {
      const batch = this.take();
      if (batch.length === 0) break;
      const settled = await Promise.all(batch.map((job) => this.runner(job)));
      results.push(...settled);
    }
    return results;
  }
}

export class RecordingLlm implements LlmProvider {
  calls: ChatMessage[][] = [];
  active = 0;
  maxActive = 0;
  delayMs = 0;
  responder: (messages: ChatMessage[]) => string = () =>
    JSON.stringify({ reply: "ok", actions: [], stopConversation: false });

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    this.active += 1;
    this.maxActive = Math.max(this.maxActive, this.active);
    try {
      if (this.delayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      return this.responder(messages);
    } finally {
      this.active -= 1;
    }
  }

  lastUserText(index = -1): string {
    const call = this.calls.at(index);
    if (!call) return "";
    const user = [...call].reverse().find((m) => m.role === "user");
    return user?.content ?? "";
  }
}

export interface Harness {
  config: Config;
  services: Services;
  crm: MockCrmClient;
  scheduler: TestScheduler;
  llm: RecordingLlm;
  store: MemoryConversationStore;
  debug: InMemoryDebugRecorder;
  ingest(message: NormalizedMessage): Promise<IngestResult>;
  makeMessage(overrides: Partial<NormalizedMessage> & { instanceId: string; chatId: string }): NormalizedMessage;
  key(instanceId: string, chatId: string): string;
  maxConcurrentByKey: Map<string, number>;
  currentByKey: Map<string, number>;
}

export function createHarness(overrides: Record<string, string> = {}): Harness {
  const env: Record<string, string> = {
    NODE_ENV: "test",
    MOCK_EXTERNALS: "true",
    MESSAGE_DEBOUNCE_MS: "50",
    WORKER_CONCURRENCY: "20",
    ALLOWED_MANAGER_IDS: "2",
    LOG_LEVEL: "silent",
    ...overrides,
  };

  const config = loadConfig(env);
  const logger = createLogger({ level: config.logLevel, pretty: false });
  const store = new MemoryConversationStore();
  const debug = new InMemoryDebugRecorder();
  const llm = new RecordingLlm();
  const scheduler = new TestScheduler();
  const crm = createCrmClient(config, logger, debug);

  const services: Services = {
    config,
    logger,
    store,
    scheduler,
    crm,
    sender: createMessageSender(config, logger, debug),
    webhookProxy: new MockWebhookProxy(debug),
    llm,
    transcription: createTranscriptionService(config, logger),
    debug,
  };

  const maxConcurrentByKey = new Map<string, number>();
  const currentByKey = new Map<string, number>();

  scheduler.setRunner(async (job) => {
    const active = (currentByKey.get(job.conversationKey) ?? 0) + 1;
    currentByKey.set(job.conversationKey, active);
    maxConcurrentByKey.set(job.conversationKey, Math.max(maxConcurrentByKey.get(job.conversationKey) ?? 0, active));
    try {
      return await handleConversationJob(
        { conversationKey: job.conversationKey, token: job.token, retryCount: job.retryCount },
        { attemptsMade: 0, maxAttempts: 1, jobId: `test-${job.token}` },
        services,
      );
    } finally {
      currentByKey.set(job.conversationKey, (currentByKey.get(job.conversationKey) ?? 1) - 1);
    }
  });

  let messageCounter = 0;
  const makeMessage: Harness["makeMessage"] = (overrides) => ({
    instanceId: overrides.instanceId,
    idMessage: overrides.idMessage ?? `test-${Date.now()}-${(messageCounter += 1)}`,
    chatId: overrides.chatId,
    senderPhone: overrides.senderPhone ?? overrides.chatId.split("@")[0].replace(/[^\d]/g, ""),
    type: overrides.type ?? "text",
    text: overrides.text ?? "hello",
    fileUrl: overrides.fileUrl,
    timestamp: overrides.timestamp ?? Date.now(),
    rawType: overrides.rawType ?? "textMessage",
  });

  return {
    config,
    services,
    crm: crm as MockCrmClient,
    scheduler,
    llm,
    store,
    debug,
    ingest: (message) => ingestMessage(message, services),
    makeMessage,
    key: conversationKey,
    maxConcurrentByKey,
    currentByKey,
  };
}
