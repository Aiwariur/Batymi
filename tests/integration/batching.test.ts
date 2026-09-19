import { describe, expect, it } from "vitest";
import { createHarness } from "../helpers/harness";

describe("message batching / debounce", () => {
  it("combines several rapid messages into a single LLM run", async () => {
    const harness = createHarness({ MESSAGE_DEBOUNCE_MS: "10000" });
    const chatId = "995555111111@c.us";
    const instanceId = harness.config.instances[0].id;

    const texts = ["Да", "я собственник", "можно работать", "хочу 85 тысяч на руки", "вид на море"];
    for (const text of texts) {
      const result = await harness.ingest(
        harness.makeMessage({ instanceId, chatId, text, type: "text" }),
      );
      expect(result.buffered).toBe(true);
    }

    expect(harness.scheduler.jobs.length).toBe(5);

    const outcomes = await harness.scheduler.runAll();
    const processed = outcomes.filter((o) => o.status === "processed");

    expect(harness.llm.calls.length).toBe(1);
    expect(processed.length).toBe(1);

    const batchText = harness.llm.lastUserText();
    for (const text of texts) expect(batchText).toContain(text);

    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
  });

  it("does not buffer duplicate webhooks twice", async () => {
    const harness = createHarness();
    const chatId = "995555222222@c.us";
    const instanceId = harness.config.instances[0].id;
    const message = harness.makeMessage({ instanceId, chatId, text: "Да, продаётся", idMessage: "dup-1" });

    const first = await harness.ingest(message);
    const second = await harness.ingest(message);

    expect(first.buffered).toBe(true);
    expect(second.duplicate).toBe(true);
    expect(harness.scheduler.jobs.length).toBe(1);

    await harness.scheduler.runAll();
    expect(harness.llm.calls.length).toBe(1);
    expect(harness.debug.snapshot().outgoing).toHaveLength(1);
  });

  it("logs unsupported message types without buffering", async () => {
    const harness = createHarness();
    const instanceId = harness.config.instances[0].id;
    const result = await harness.ingest(
      harness.makeMessage({
        instanceId,
        chatId: "995555333333@c.us",
        type: "unsupported",
        rawType: "locationMessage",
      }),
    );

    expect(result.accepted).toBe(true);
    expect(result.buffered).toBe(false);
    expect(harness.scheduler.jobs).toHaveLength(0);
  });
});
