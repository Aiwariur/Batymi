import { describe, expect, it } from "vitest";
import { conversationKey, pendingKey, seenKey } from "../../src/buffer/keys";

describe("conversationKey", () => {
  it("includes the instance id and the chat id", () => {
    expect(conversationKey("instance1", "user1@c.us")).toBe("instance1:user1@c.us");
  });

  it("keeps the same contact isolated across different instances", () => {
    const a = conversationKey("instance1", "user1@c.us");
    const b = conversationKey("instance2", "user1@c.us");
    expect(a).not.toBe(b);
  });

  it("keeps different contacts isolated on the same instance", () => {
    const a = conversationKey("instance1", "user1@c.us");
    const b = conversationKey("instance1", "user2@c.us");
    expect(a).not.toBe(b);
  });

  it("derives stable redis keys", () => {
    expect(pendingKey("instance1:user1@c.us")).toBe("conversation:instance1:user1@c.us:pending");
    expect(seenKey("instance1", "msg-1")).toBe("seen:instance1:msg-1");
  });
});
