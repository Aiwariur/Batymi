import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness";
import { ChatMessage } from "../../src/agent/llm.provider";

describe("concurrency", () => {
  it("processes 5 instances x 10 contacts concurrently and keeps data isolated", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "50", WORKER_CONCURRENCY: "20" });
    const instances = harness.config.instances.slice(0, 5);
    harness.llm.delayMs = 20;
    harness.llm.responder = (messages: ChatMessage[]) => {
      const user = [...messages].reverse().find((m) => m.role === "user");
      return JSON.stringify({ reply: user?.content ?? "", actions: [], stopConversation: false });
    };

    const expected = new Map<string, string>();
    for (const instance of instances) {
      for (let c = 0; c < 10; c += 1) {
        const chatId = `99555${c}${instance.id.replace(/\D/g, "").slice(-4)}@c.us`;
        const text = `msg-${instance.id}-${c}`;
        expected.set(`${instance.id}:${chatId}`, text);
        await harness.ingest(harness.makeMessage({ instanceId: instance.id, chatId, text }));
      }
    }

    expect(harness.scheduler.jobs.length).toBe(50);

    const outcomes = await harness.scheduler.runAllParallel();
    expect(outcomes.filter((o) => o.status === "processed")).toHaveLength(50);

    expect(harness.llm.maxActive).toBeGreaterThan(1);
    expect(harness.llm.calls.length).toBe(50);

    const outgoing = harness.debug.snapshot().outgoing;
    expect(outgoing).toHaveLength(50);
    for (const message of outgoing) {
      expect(message.message).toBe(expected.get(`${message.instanceId}:${message.chatId}`));
    }
  });
});
