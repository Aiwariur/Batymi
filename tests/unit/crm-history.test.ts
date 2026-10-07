import { describe, expect, it } from "vitest";
import { CrmInteraction } from "../../src/crm/crm.client";
import { assembleCrmHistory } from "../../src/conversation/crm-history";
import { HistoryEntry, NormalizedMessage } from "../../src/types";

const interaction = (overrides: Partial<CrmInteraction> & Pick<CrmInteraction, "id" | "sent_at" | "text">): CrmInteraction => ({
  direction: "outgoing",
  sender: "agent",
  instance_id: "instance-a",
  ...overrides,
});

const batchMessage: NormalizedMessage = {
  instanceId: "instance-a",
  idMessage: "batch-message",
  chatId: "995555123456@c.us",
  senderPhone: "+995555123456",
  type: "text",
  text: "Новая реплика",
  timestamp: Date.parse("2026-10-04T10:30:00Z"),
  rawType: "textMessage",
};

describe("assembleCrmHistory", () => {
  it("filters to the current instance, sorts chronologically, and deduplicates IDs", () => {
    const rows = [
      interaction({ id: 9, sent_at: "2026-10-04T10:30:00Z", text: "current from CRM", message_id: "batch-message", direction: "incoming", sender: null }),
      interaction({ id: 8, sent_at: "2026-10-04T10:25:00Z", text: "manager reply", message_id: "manager-1", sender: "manager" }),
      interaction({ id: 3, sent_at: "2026-10-04T10:20:00Z", text: "agent reply", message_id: "agent-1" }),
      interaction({ id: 2, sent_at: "2026-10-04T10:10:00Z", text: "owner first", message_id: "owner-1", direction: "incoming", sender: null }),
      interaction({ id: 1, sent_at: "2026-10-04T10:05:00Z", text: "other instance", message_id: "other-1", instance_id: "instance-b" }),
      interaction({ id: 4, sent_at: "2026-10-04T10:11:00Z", text: "duplicate owner row", message_id: "owner-1", direction: "incoming", sender: null }),
    ];
    const local: HistoryEntry[] = [
      { role: "user", content: "local copy of batch", ts: Date.parse("2026-10-04T10:30:00Z"), messageId: "batch-message" },
      { role: "assistant", content: "local-only reply", ts: Date.parse("2026-10-04T10:40:00Z"), messageId: "local-1", sender: "agent" },
    ];

    const result = assembleCrmHistory(rows, local, [batchMessage], "instance-a");

    expect(result.history.map(({ content }) => content)).toEqual([
      "owner first", "agent reply", "manager reply", "local-only reply",
    ]);
    expect(result.history.filter(({ messageId }) => messageId === "owner-1")).toHaveLength(1);
    // The current batch is supplied separately to the model, so CRM and local copies are omitted.
    expect(result.history.filter(({ messageId }) => messageId === "batch-message")).toHaveLength(0);
    expect(result.history.some(({ messageId }) => messageId === "other-1")).toBe(false);
    expect(result.managerTakeover).toBe(true);
  });

  it("does not treat an outgoing row without sender metadata as an agent reply", () => {
    const result = assembleCrmHistory(
      [
        interaction({ id: 1, sent_at: "2026-10-04T10:10:00Z", text: "manager message", message_id: "manager-1", sender: "manager" }),
        interaction({ id: 2, sent_at: "2026-10-04T10:20:00Z", text: "senderless legacy message", message_id: "legacy-1", sender: null }),
      ],
      [],
      [],
      "instance-a",
    );

    expect(result.managerTakeover).toBe(true);
    expect(result.history[1]).toMatchObject({ content: "senderless legacy message", sender: "unknown" });
  });
});
