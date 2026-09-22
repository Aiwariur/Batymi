import { describe, expect, it, vi } from "vitest";
import { createHarness } from "../helpers/harness";
import { MessageSender } from "../../src/crm/reply.sender";
import { SendMessageInput, SendMessageResult } from "../../src/crm/reply.sender";

function messageInput(harness: ReturnType<typeof createHarness>) {
  const instanceId = harness.config.instances[0].id;
  return {
    instanceId,
    chatId: "995555123456@c.us",
    text: "Да, квартира свободна",
  };
}

class RecordingSender implements MessageSender {
  calls: SendMessageInput[] = [];
  constructor(private readonly result?: SendMessageResult, private readonly failure?: Error) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    this.calls.push(input);
    if (this.failure) throw this.failure;
    return this.result ?? { idMessage: "crm-1", mocked: false };
  }
}

async function ingestOne(harness: ReturnType<typeof createHarness>): Promise<string> {
  const input = messageInput(harness);
  await harness.ingest(harness.makeMessage(input));
  return harness.key(input.instanceId, input.chatId);
}

describe("durable outbound safety", () => {
  it("quarantines a lost CRM response and never retries the remote send", async () => {
    const harness = createHarness();
    const sender = new RecordingSender(undefined, new Error("request timed out after CRM accepted it"));
    harness.services.sender = sender;
    const key = await ingestOne(harness);

    const outcomes = await harness.scheduler.runAll();
    expect(outcomes.at(-1)?.status).toBe("quarantined");
    expect(sender.calls).toHaveLength(1);
    expect((await harness.store.getActiveBatch(key))?.outbound?.state).toBe("ambiguous");
    expect((await harness.store.getActiveBatch(key))?.quarantineReason).toContain("manual reconciliation");

    // A new webhook still queues, but the quarantined batch remains a hard stop.
    await harness.ingest(harness.makeMessage({ ...messageInput(harness), idMessage: "after-ambiguous" }));
    const retry = await harness.scheduler.runAll();
    expect(retry.at(-1)?.status).toBe("quarantined");
    expect(sender.calls).toHaveLength(1);
  });

  it("quarantines when persistence fails after the remote send", async () => {
    const harness = createHarness();
    const sender = new RecordingSender();
    harness.services.sender = sender;
    harness.store.markOutboundSent = vi.fn(async () => {
      throw new Error("database write lost after response");
    });
    const key = await ingestOne(harness);

    const outcomes = await harness.scheduler.runAll();
    expect(outcomes.at(-1)?.status).toBe("quarantined");
    expect(sender.calls).toHaveLength(1);
    expect((await harness.store.getActiveBatch(key))?.outbound?.state).toBe("ambiguous");

    await harness.ingest(harness.makeMessage({ ...messageInput(harness), idMessage: "after-persistence-error" }));
    await harness.scheduler.runAll();
    expect(sender.calls).toHaveLength(1);
  });

  it("does not send when a worker crashed after claiming the outbound intent", async () => {
    const harness = createHarness();
    const sender = new RecordingSender();
    harness.services.sender = sender;
    const key = await ingestOne(harness);
    const lock = await harness.store.acquireLock(key, harness.config.conversationLockTtlMs);
    expect(lock).not.toBeNull();
    const batch = await harness.store.drainPending(key);
    const active = await harness.store.getActiveBatch(key);
    expect(batch).toHaveLength(1);
    expect(active).not.toBeNull();
    const intent = await harness.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: batch[0].instanceId,
      chatId: batch[0].chatId,
      message: "prepared before process crash",
    });
    await harness.store.claimOutboundIntent(key, intent.intentId);
    await harness.store.releaseLock(key, lock!.token);

    const outcomes = await harness.scheduler.runAll();
    expect(outcomes.at(-1)?.status).toBe("quarantined");
    expect(sender.calls).toHaveLength(0);
  });

  it("allows only one claim for an intent", async () => {
    const harness = createHarness();
    const key = await ingestOne(harness);
    const lock = await harness.store.acquireLock(key, harness.config.conversationLockTtlMs);
    const batch = await harness.store.drainPending(key);
    const active = await harness.store.getActiveBatch(key);
    const intent = await harness.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: batch[0].instanceId,
      chatId: batch[0].chatId,
      message: "one claim",
    });

    const [first, second] = await Promise.all([
      harness.store.claimOutboundIntent(key, intent.intentId),
      harness.store.claimOutboundIntent(key, intent.intentId),
    ]);
    expect([first, second].filter(Boolean)).toHaveLength(1);
    expect([first, second].filter((claim) => claim?.state === "sending")).toHaveLength(1);
    await harness.store.releaseLock(key, lock!.token);
  });

  it("recovers a confirmed send without rerunning CRM actions or the LLM", async () => {
    const harness = createHarness();
    const sender = new RecordingSender();
    harness.services.sender = sender;
    const key = await ingestOne(harness);
    const lock = await harness.store.acquireLock(key, harness.config.conversationLockTtlMs);
    const batch = await harness.store.drainPending(key);
    const active = await harness.store.getActiveBatch(key);
    const intent = await harness.store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: active!.batchKey,
      instanceId: batch[0].instanceId,
      chatId: batch[0].chatId,
      message: "already delivered",
    });
    await harness.store.claimOutboundIntent(key, intent.intentId);
    await harness.store.markOutboundSent(key, intent.intentId, "crm-confirmed");
    await harness.store.releaseLock(key, lock!.token);

    const outcomes = await harness.scheduler.runAll();
    expect(outcomes.at(-1)?.status).toBe("processed");
    expect(outcomes.at(-1)?.reply).toBe("already delivered");
    expect(sender.calls).toHaveLength(0);
    expect(harness.llm.calls).toHaveLength(0);
  });

  it("keeps one sender call when duplicate jobs race for a conversation", async () => {
    const harness = createHarness();
    const sender = new RecordingSender();
    harness.services.sender = {
      sendMessage: async (input) => {
        await new Promise((resolve) => setTimeout(resolve, 30));
        return sender.sendMessage(input);
      },
    };
    const input = messageInput(harness);
    await harness.ingest(harness.makeMessage(input));
    const first = harness.scheduler.runNext();
    await new Promise((resolve) => setTimeout(resolve, 5));
    await harness.scheduler.schedule(harness.key(input.instanceId, input.chatId), await harness.store.getDebounce(harness.key(input.instanceId, input.chatId)) ?? "", 0);
    const second = harness.scheduler.runNext();
    const results = await Promise.all([first, second]);

    expect(results.map((result) => result?.status)).toContain("rescheduled");
    expect(sender.calls).toHaveLength(1);
  });
});
