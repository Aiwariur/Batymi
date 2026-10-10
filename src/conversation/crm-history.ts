import { CrmInteraction } from "../crm/crm.client";
import { HistoryEntry, NormalizedMessage } from "../types";

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
  return Number.isFinite(parsed) ? parsed : 0;
}

/** Redis history written before ingress normalization may still contain epoch seconds. */
function historyTimestamp(value: number): number {
  return Number.isFinite(value) && value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
}

function isAudioPlaceholder(content: string): boolean {
  return content.trim() === "🎵 Аудио";
}

export function assembleCrmHistory(rows: CrmInteraction[], local: HistoryEntry[], batch: NormalizedMessage[], instanceId: string) {
  const normalizedLocal = local.map(entry => ({ ...entry, ts: historyTimestamp(entry.ts) }));
  const currentIds = new Set(batch.map(message => message.idMessage));
  const seen = new Set<string>();
  const ordered = rows.filter(row => row.instance_id === instanceId).sort((a, b) =>
    timestamp(a.sent_at) - timestamp(b.sent_at) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  let managerTakeover = false;
  for (const row of ordered) {
    if (row.direction !== "outgoing") continue;
    if (row.sender === "manager") managerTakeover = true;
    // Only the explicit CRM outreach marker exempts a phone-sent initial contact.
    // Older API outreach is stored with a null sender; an unmarked phone sender is manual.
    if (row.sender === "phone" && !row.notes?.startsWith("cooperation_outreach:v1:")) managerTakeover = true;
  }
  const history: HistoryEntry[] = [];
  const localByMessageId = new Map(normalizedLocal.filter(entry => entry.messageId).map(entry => [entry.messageId!, entry]));
  for (const row of ordered) {
    const identity = row.message_id ? `message:${row.message_id}` : `interaction:${row.id}`;
    if (seen.has(identity) || row.message_id && currentIds.has(row.message_id)) continue;
    seen.add(identity);
    const localCopy = row.message_id ? localByMessageId.get(row.message_id) : undefined;
    const content = isAudioPlaceholder(row.text) && localCopy?.content && !isAudioPlaceholder(localCopy.content)
      ? localCopy.content : row.text;
    history.push({ role: row.direction === "incoming" ? "user" : "assistant", content,
      ts: timestamp(row.sent_at), messageId: row.message_id ?? undefined, sender: row.direction === "incoming" ? "owner" : row.sender ?? "unknown" });
  }
  // The CRM proxy is async: merge local messages only when absent from CRM.
  for (const entry of normalizedLocal) {
    if (entry.messageId && (currentIds.has(entry.messageId) || seen.has(`message:${entry.messageId}`))) continue;
    if (!entry.messageId && history.some(row => row.role === entry.role && row.content === entry.content && Math.abs(row.ts - entry.ts) < 60000)) continue;
    history.push(entry);
    if (entry.messageId) seen.add(`message:${entry.messageId}`);
  }
  history.sort((a, b) => a.ts - b.ts);
  return { history, managerTakeover };
}
