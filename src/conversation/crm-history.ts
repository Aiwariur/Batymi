import { CrmInteraction } from "../crm/crm.client";
import { HistoryEntry, NormalizedMessage } from "../types";

function timestamp(value: string | null): number {
  if (!value) return 0;
  const parsed = Date.parse(/[zZ]|[+-]\d\d:\d\d$/.test(value) ? value : value + "Z");
  return Number.isFinite(parsed) ? parsed : 0;
}
export function assembleCrmHistory(rows: CrmInteraction[], local: HistoryEntry[], batch: NormalizedMessage[], instanceId: string) {
  const currentIds = new Set(batch.map(message => message.idMessage));
  const seen = new Set<string>();
  const ordered = rows.filter(row => row.instance_id === instanceId).sort((a, b) =>
    timestamp(a.sent_at) - timestamp(b.sent_at) || String(a.id).localeCompare(String(b.id), undefined, { numeric: true }));
  const lastAgent = ordered.findLastIndex(row => row.direction === "outgoing" && row.sender === "agent");
  const managerTakeover = ordered.some((row, index) => row.direction === "outgoing" && row.sender === "manager" && index > lastAgent);
  const history: HistoryEntry[] = [];
  for (const row of ordered) {
    const identity = row.message_id ? `message:${row.message_id}` : `interaction:${row.id}`;
    if (seen.has(identity) || row.message_id && currentIds.has(row.message_id)) continue;
    seen.add(identity);
    history.push({ role: row.direction === "incoming" ? "user" : "assistant", content: row.text,
      ts: timestamp(row.sent_at), messageId: row.message_id ?? undefined, sender: row.direction === "incoming" ? "owner" : row.sender ?? "unknown" });
  }
  // The CRM proxy is async: merge local messages only when absent from CRM.
  for (const entry of local) {
    if (entry.messageId && (currentIds.has(entry.messageId) || seen.has(`message:${entry.messageId}`))) continue;
    if (!entry.messageId && history.some(row => row.role === entry.role && row.content === entry.content && Math.abs(row.ts - entry.ts) < 60000)) continue;
    history.push(entry);
    if (entry.messageId) seen.add(`message:${entry.messageId}`);
  }
  history.sort((a, b) => a.ts - b.ts);
  return { history, managerTakeover };
}
