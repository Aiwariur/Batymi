import { loadConfig } from "../../src/config/env";
import { LlmProvider, ChatMessage } from "../../src/agent/llm.provider";
import { handleConversationJob, RunOutcome } from "../../src/conversation/conversation.service";
import { createLogger } from "../../src/observability/logger";
import { InMemoryDebugRecorder } from "../../src/observability/debug-recorder";
import { MemoryConversationStore } from "../../src/buffer/memory-store";
import { RealCrmClient } from "../../src/crm/crm.client";
import { CrmReplySender } from "../../src/crm/reply.sender";
import { MockWebhookProxy } from "../../src/crm/webhook-proxy";
import { createTranscriptionService } from "../../src/transcription/transcription.service";
import { Services } from "../../src/services";
import { NormalizedMessage } from "../../src/types";
import { ingestMessage } from "../../src/buffer/message-buffer";
import { conversationKey } from "../../src/buffer/keys";
import { CrmWrite, OwnerDialogueTestCrm } from "./owner-dialogue-server";
import { makeScenarioListings, OwnerDialogueScenario, OwnerDialogueTurn } from "../conversations/owner-dialogue-corpus";

export class ScriptedOwnerDialogueLlm implements LlmProvider {
  readonly calls: ChatMessage[][] = [];
  readonly rawOutputs: string[] = [];
  private turnIndex = 0;

  constructor(private readonly turns: OwnerDialogueTurn[]) {}

  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const turn = this.turns[this.turnIndex];
    if (!turn) throw new Error(`scripted LLM received unexpected call after turn ${this.turnIndex}`);
    const executionPhase = messages.some((message) => message.role === "system" && message.content.startsWith("CRM_EXECUTION_RESULTS:"));
    if (executionPhase) {
      const reply = turn.finalReply ?? turn.plannedReply;
      this.turnIndex += 1;
      const raw = JSON.stringify({ reply, actions: [], stopConversation: turn.expect.stopConversation ?? false });
      this.rawOutputs.push(raw);
      return raw;
    }
    if (turn.actions.length === 0) this.turnIndex += 1;
    const raw = JSON.stringify({ reply: turn.plannedReply, actions: turn.actions, stopConversation: turn.expect.stopConversation ?? false, ...(turn.selectedListingId !== undefined ? { selectedListingId: turn.selectedListingId } : {}) });
    this.rawOutputs.push(raw);
    return raw;
  }
}

export class CountingLlmProvider implements LlmProvider {
  readonly calls: ChatMessage[][] = [];
  readonly rawOutputs: string[] = [];
  constructor(private readonly delegate: LlmProvider) {}
  async complete(messages: ChatMessage[]): Promise<string> {
    this.calls.push(messages);
    const raw = await this.delegate.complete(messages);
    this.rawOutputs.push(raw);
    return raw;
  }
}

export interface TurnRunRecord {
  runId: string;
  outcome: RunOutcome;
  before: unknown;
  after: unknown;
  writeEvents: unknown[];
  sentMessages: unknown[];
  duplicateAccepted?: boolean;
  totalSentAfter: number;
  totalWritesAfter: number;
  modelCallsBefore: number;
  modelCallsAfter: number;
  modelOutputs: string[];
  attempts: Array<{ outcome: RunOutcome; before: unknown; after: unknown; sentCount: number; writeEvents: unknown[] }>;
}

export interface OwnerDialogueRuntime {
  services: Services;
  llm: LlmProvider;
  store: MemoryConversationStore;
  crm: OwnerDialogueTestCrm;
  modelCallCount(): number;
  modelOutputs(): string[];
  close(): Promise<void>;
}

export async function createOwnerDialogueRuntime(
  scenario: OwnerDialogueScenario,
  llmFactory: (turns: OwnerDialogueTurn[], config: ReturnType<typeof loadConfig>, logger: ReturnType<typeof createLogger>) => LlmProvider,
): Promise<OwnerDialogueRuntime> {
  const crm = new OwnerDialogueTestCrm({
    phone: "+995599123456", contact_type: scenario.initialContactType ?? null,
    listings: makeScenarioListings(scenario),
    interactions: structuredClone(scenario.initialInteractions ?? []),
  });
  await crm.start();
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NODE_ENV: "test", MOCK_EXTERNALS: "false", MOCK_CRM: "false", MOCK_LLM: "false",
    MOCK_GREENAPI: "true", MOCK_TRANSCRIPTION: "true", CRM_BASE_URL: crm.baseUrl, CRM_API_KEY: crm.apiKey,
    GREENAPI_INSTANCES: JSON.stringify([{ id: "acceptance-instance", token: "local-test-token", managerId: 2 }]),
    ALLOWED_MANAGER_IDS: "2", TERMINAL_CRM_STATUSES: "qualified,disagreed,sold,archived,listing_removed",
    LOG_LEVEL: "silent", LOG_MESSAGE_CONTENT: "false", MESSAGE_DEBOUNCE_MS: "1",
  };
  const config = loadConfig(env);
  const logger = createLogger({ level: "silent", pretty: false });
  const store = new MemoryConversationStore();
  const debug = new InMemoryDebugRecorder();
  const llm = llmFactory(scenario.turns, config, logger);
  const scheduler = { schedule: async () => undefined, close: async () => undefined };
  const services: Services = {
    config, logger, store, scheduler,
    crm: new RealCrmClient(config, logger), sender: new CrmReplySender(config, logger),
    webhookProxy: new MockWebhookProxy(debug), llm,
    transcription: createTranscriptionService(config, logger), debug,
  };
  return {
    services, llm, store, crm,
    modelCallCount: () => (llm as { calls?: ChatMessage[][] }).calls?.length ?? 0,
    modelOutputs: () => [ ...((llm as { rawOutputs?: string[] }).rawOutputs ?? []) ],
    close: () => crm.close(),
  };
}

export async function runOwnerDialogueTurn(
  runtime: OwnerDialogueRuntime,
  turn: OwnerDialogueTurn,
  sequence: number,
): Promise<TurnRunRecord> {
  const services = runtime.services;
  const key = conversationKey("acceptance-instance", "995599123456@c.us");
  const before = runtime.crm.snapshot();
  const writesStart = runtime.crm.writes.length;
  const sentStart = runtime.crm.sentMessages.length;
  const modelCallsBefore = runtime.modelCallCount();
  const modelOutputStart = runtime.modelOutputs().length;
  const id = `owner-dialogue-${sequence}`;
  const ownerMessages = turn.ownerMessages ?? [turn.ownerText];
  if (ownerMessages.join("\n") !== turn.ownerText) throw new Error("ownerMessages must match ownerText");
  const messages: NormalizedMessage[] = ownerMessages.map((text, index) => ({
    instanceId: "acceptance-instance", idMessage: ownerMessages.length === 1 ? id : `${id}-${index}`, chatId: "995599123456@c.us", senderPhone: "995599123456",
    type: "text", text, timestamp: Date.now() + sequence + index, rawType: "textMessage",
  }));
  for (const message of messages) {
    runtime.crm.addOwnerMessage(message.text!, message.idMessage, "acceptance-instance");
    await ingestMessage(message, services);
  }
  let duplicateAccepted: boolean | undefined;
  if (turn.duplicateWebhook) duplicateAccepted = (await ingestMessage(messages[messages.length - 1], services)).accepted;
  if (turn.failCrmWrite) runtime.crm.failNextWrite = true;
  const token = await services.store.getDebounce(key);
  if (!token) throw new Error(`missing debounce token for ${turn.ownerText}`);
  const lockProbe = await services.store.acquireLock(key, services.config.conversationLockTtlMs);
  if (!lockProbe) throw new Error(`test store lock already held for ${key}`);
  await services.store.releaseLock(key, lockProbe.token);
  let outcome = await handleConversationJob(
    { conversationKey: key, token }, { attemptsMade: 0, maxAttempts: 1, jobId: id }, services,
  );
  const attempts: TurnRunRecord["attempts"] = [{ outcome: structuredClone(outcome), before, after: runtime.crm.snapshot(), sentCount: runtime.crm.sentMessages.length - sentStart, writeEvents: structuredClone(runtime.crm.writes.slice(writesStart)) }];
  for (let retryNumber = 1; outcome.status === "rescheduled" && retryNumber <= 2; retryNumber += 1) {
    const retryToken = await services.store.getDebounce(key);
    if (!retryToken) throw new Error(`rescheduled run ${retryNumber} did not create a retry token`);
    const retryBefore = attempts[attempts.length - 1].after;
    const retryWritesStart = runtime.crm.writes.length;
    outcome = await handleConversationJob(
      { conversationKey: key, token: retryToken, retryCount: retryNumber }, { attemptsMade: 0, maxAttempts: 1, jobId: `${id}-retry-${retryNumber}` }, services,
    );
    attempts.push({ outcome: structuredClone(outcome), before: retryBefore, after: runtime.crm.snapshot(), sentCount: runtime.crm.sentMessages.length - sentStart, writeEvents: structuredClone(runtime.crm.writes.slice(retryWritesStart)) });
  }
  return {
    runId: outcome.runId, outcome, before, after: runtime.crm.snapshot(),
    writeEvents: structuredClone(runtime.crm.writes.slice(writesStart)),
    sentMessages: structuredClone(runtime.crm.sentMessages.slice(sentStart)),
    totalSentAfter: runtime.crm.sentMessages.length,
    totalWritesAfter: runtime.crm.writes.length,
    duplicateAccepted, modelCallsBefore, modelCallsAfter: runtime.modelCallCount(),
    modelOutputs: runtime.modelOutputs().slice(modelOutputStart),
    attempts,
  };
}

export function getPath(value: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>((current, key) => {
    if (current === null || typeof current !== "object") return undefined;
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function writeSignature(event: { path?: string; body?: unknown }): string {
  const path = event.path ?? "";
  const body = (event.body ?? {}) as Record<string, unknown>;
  if (path === "/chat/reply") return "reply";
  if (path === "/status/set") return `status:${body.status}`;
  if (path.endsWith("/type")) return `contact_type:${body.contact_type}`;
  const rental = path.match(/\/listings\/([^/]+)\/rental-terms$/);
  if (rental) return `rental:${rental[1]}:${Object.keys(body).sort().join(",")}`;
  if (path.endsWith("/deal")) return `deal:${body.listing_id}:${Object.keys(body).filter((key) => key !== "listing_id").sort().join(",")}`;
  return path;
}

export function primaryListingSnapshot(snapshot: unknown, listingId?: string | number): Record<string, unknown> {
  const listings = (snapshot as { listings?: Array<Record<string, unknown>> }).listings ?? [];
  return listings.find((listing) => listing.id === listingId) ?? listings[0] ?? {};
}
