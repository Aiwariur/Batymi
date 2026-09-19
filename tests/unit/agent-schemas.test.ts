import { describe, expect, it } from "vitest";
import { agentResultSchema } from "../../src/agent/schemas";

describe("agent structured output", () => {
  it("accepts a valid result", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "Отлично",
      actions: [{ type: "set_contact_type", contactType: "owner" }],
      stopConversation: false,
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects unknown action types", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "hi",
      actions: [{ type: "send_http_request", url: "http://evil" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an invalid contact type", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "hi",
      actions: [{ type: "set_contact_type", contactType: "superadmin" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("rejects an invalid crm status", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "hi",
      actions: [{ type: "set_crm_status", status: "closed" }],
    });
    expect(parsed.success).toBe(false);
  });

  it("normalizes action enum casing", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "hi",
      actions: [
        { type: "set_contact_type", contactType: "OWNER" },
        { type: "set_crm_status", status: "Qualified" },
      ],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.actions[0]).toMatchObject({ contactType: "owner" });
      expect(parsed.data.actions[1]).toMatchObject({ status: "qualified" });
    }
  });

  it("fills missing deal fields with empty strings", () => {
    const parsed = agentResultSchema.safeParse({
      reply: "hi",
      actions: [{ type: "update_deal_info", data: { window_view: "море" } }],
    });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.actions[0]).toMatchObject({
        data: {
          commission_type: "",
          commission_value: "",
          price_net: "",
          window_view: "море",
          complex_name: "",
          cadastral_code: "",
          agent_notes: "",
        },
      });
    }
  });

  it("defaults actions and stopConversation when omitted", () => {
    const parsed = agentResultSchema.safeParse({ reply: "hi" });
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.actions).toEqual([]);
      expect(parsed.data.stopConversation).toBe(false);
    }
  });
});
