import { createHash } from "crypto";

/** Stable CRM-safe fallback key for recovery issues lacking an active batch ID. */
export function recoveryIssueId(conversationKey: string): string {
  const digest = createHash("sha256").update(conversationKey).digest("hex");
  return `recovery:${digest}`;
}
