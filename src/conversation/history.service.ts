import { ConversationStore } from "../buffer/conversation-store";
import { HistoryEntry } from "../types";

export interface HistoryConfig {
  maxMessages: number;
  ttlSeconds: number;
}

export async function appendHistory(
  store: ConversationStore,
  conversationKey: string,
  entry: HistoryEntry,
  config: HistoryConfig,
): Promise<void> {
  await store.appendHistory(conversationKey, entry, config.maxMessages, config.ttlSeconds);
}

export async function getHistory(
  store: ConversationStore,
  conversationKey: string,
  config: HistoryConfig,
): Promise<HistoryEntry[]> {
  return store.getHistory(conversationKey, config.maxMessages);
}
