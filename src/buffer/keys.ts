/**
 * Conversation key is the isolation boundary of the whole system.
 * The same WhatsApp contact may exist on several GreenAPI instances, so the
 * instance id MUST be part of the key.
 */
export function conversationKey(instanceId: string, chatId: string): string {
  return `${instanceId}:${chatId}`;
}

export function seenKey(instanceId: string, idMessage: string): string {
  return `seen:${instanceId}:${idMessage}`;
}

export function pendingKey(key: string): string {
  return `conversation:${key}:pending`;
}

export function debounceKey(key: string): string {
  return `conversation:${key}:debounce`;
}

export function lockKey(key: string): string {
  return `conversation:${key}:lock`;
}

export function historyKey(key: string): string {
  return `conversation:${key}:history`;
}

/**
 * The debounce token must stay alive at least until the delayed job that reads
 * it fires, otherwise the job would consider itself stale and the message would
 * be lost. The actual debounce timing is enforced by the job delay, so the TTL
 * only needs to outlive the scheduled job.
 */
export function debounceTtlMs(debounceMs: number): number {
  return debounceMs + 60000;
}
