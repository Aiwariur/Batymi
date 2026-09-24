import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness";
import { ChatMessage } from "../../src/agent/llm.provider";

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

describe("same-conversation race", () => {
  it("does not run two conflicting processes for one conversation and does not lose messages", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "50" });
    const instanceId = harness.config.instances[0].id;
    const chatId = "995555999999@c.us";
    const key = harness.key(instanceId, chatId);

    harness.llm.delayMs = 100;
    harness.llm.responder = (messages: ChatMessage[]) => {
      const user = [...messages].reverse().find((m) => m.role === "user");
      return JSON.stringify({ reply: user?.content ?? "", actions: [], stopConversation: false });
    };

    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "first batch" }));

    const firstRun = harness.scheduler.runNext();
    await sleep(20);

    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "second batch" }));

    const conflictingRun = harness.scheduler.runNext();
    const [first, conflicting] = await Promise.all([firstRun, conflictingRun]);

    expect(first?.status).toBe("processed");
    expect(conflicting?.status).toBe("rescheduled");

    const rest = await harness.scheduler.runAll();
    expect(rest.some((o) => o.status === "processed")).toBe(true);

    expect(harness.llm.maxActive).toBe(1);
    expect(harness.llm.calls.length).toBe(2);
    expect(harness.llm.lastUserText(0)).toContain("first batch");
    expect(harness.llm.lastUserText(1)).toContain("second batch");

    const outgoing = harness.debug.snapshot().outgoing;
    expect(outgoing).toHaveLength(2);
    expect(outgoing[0].message).toBe("first batch");
    expect(outgoing[1].message).toBe("second batch");
  });

  it("picks up messages that arrive while a batch is being processed", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "50" });
    const instanceId = harness.config.instances[0].id;
    const chatId = "995555888888@c.us";

    harness.llm.delayMs = 60;
    harness.llm.responder = (messages: ChatMessage[]) => {
      const user = [...messages].reverse().find((m) => m.role === "user");
      return JSON.stringify({ reply: user?.content ?? "", actions: [], stopConversation: false });
    };

    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "batch A" }));
    const runA = harness.scheduler.runNext();
    await sleep(10);
    await harness.ingest(harness.makeMessage({ instanceId, chatId, text: "batch B" }));
    await runA;

    const outcomes = await harness.scheduler.runAll();
    expect(outcomes.some((o) => o.status === "processed")).toBe(true);
    expect(harness.llm.calls.length).toBe(2);
    expect(harness.llm.lastUserText(1)).toContain("batch B");
    const replies = harness.debug.snapshot().outgoing.map((m) => m.message);
    expect(replies).toEqual(["batch A", "batch B"]);
  });
});
