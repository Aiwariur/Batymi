import { describe, expect, it } from "vitest";
import { MemoryConversationStore } from "../../src/buffer/memory-store";
import { AgentCheckpoint } from "../../src/buffer/conversation-store";
import { NormalizedMessage } from "../../src/types";

const inbound: NormalizedMessage = {
  instanceId: "instance-1",
  idMessage: "message-1",
  chatId: "995555000000@c.us",
  senderPhone: "995555000000",
  type: "text",
  text: "Owner reply",
  timestamp: 1,
  rawType: "textMessage",
};

const checkpoint: AgentCheckpoint = {
  result: {
    reply: "Final reply",
    stopConversation: false,
    actions: [{ type: "set_contact_type", contactType: "owner" }],
  },
  completedActions: 1,
  reply: "Final reply",
  finalized: true,
};

describe("durable active batch agent checkpoint", () => {
  it("survives recovery and preserves the outbound intent", async () => {
    const store = new MemoryConversationStore();
    const key = "instance-1:995555000000@c.us";
    await store.pushPending(key, inbound);
    await store.drainPending(key);
    const batch = await store.getActiveBatch(key);
    const lock = await store.acquireLock(key, 60_000);
    expect(batch).not.toBeNull();
    expect(lock).not.toBeNull();

    await store.prepareOutboundIntent({
      conversationKey: key,
      batchKey: batch!.batchKey,
      instanceId: "instance-1",
      chatId: inbound.chatId,
      message: "Final reply",
    });
    await store.saveAgentCheckpoint(key, batch!.batchKey, checkpoint, lock!.token);

    const recovered = await store.getActiveBatch(key);
    expect(recovered?.agentCheckpoint).toEqual(checkpoint);
    expect(recovered?.outbound?.message).toBe("Final reply");
    expect(recovered?.outbound?.state).toBe("prepared");
  });

  it("rejects stale batches, invalid progress, stale locks, and progress rollback", async () => {
    const store = new MemoryConversationStore();
    const key = "instance-1:995555000000@c.us";
    await store.pushPending(key, inbound);
    await store.drainPending(key);
    const batch = await store.getActiveBatch(key);
    const firstLock = await store.acquireLock(key, 60_000);
    expect(batch).not.toBeNull();
    expect(firstLock).not.toBeNull();

    await expect(store.saveAgentCheckpoint(key, "stale-batch", checkpoint)).rejects.toThrow(/active batch/);
    await expect(
      store.saveAgentCheckpoint(key, "stale-batch", { ...checkpoint, completedActions: 2 }),
    ).rejects.toThrow(/completedActions/);

    const initial = { ...checkpoint, completedActions: 0, finalized: false, reply: undefined };
    await store.saveAgentCheckpoint(key, batch!.batchKey, initial, firstLock!.token);
    await store.saveAgentCheckpoint(key, batch!.batchKey, checkpoint, firstLock!.token);
    await expect(
      store.saveAgentCheckpoint(key, batch!.batchKey, initial, firstLock!.token),
    ).rejects.toThrow(/backwards/);

    await store.releaseLock(key, firstLock!.token);
    const nextLock = await store.acquireLock(key, 60_000);
    expect(nextLock).not.toBeNull();
    await expect(
      store.saveAgentCheckpoint(key, batch!.batchKey, checkpoint, firstLock!.token),
    ).rejects.toThrow(/conversation lock/);
  });
});
