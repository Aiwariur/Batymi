import { AgentOutputError } from "../agent/agent";
import { AgentResult } from "../agent/schemas";
import { LlmProvider } from "../agent/llm.provider";
import { CrmInteraction } from "../crm/crm.client";
import { HistoryEntry, Listing } from "../types";
import { OUTREACH_QUESTION, planOwnerReply } from "./owner-dialogue-core";

export const COOPERATION_QUESTION = OUTREACH_QUESTION;
export const COOPERATION_PLANNER_VERSION = "owner_dialogue_v2";
export type CooperationResult = AgentResult & { handoffReason?: string };

export function publicListingUrl(value?: string | null, crmBaseUrl?: string): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    if (!["https:", "http:"].includes(url.protocol) || url.username || url.password) return undefined;
    const internal = new Set(["admin.batumi-key.homes", "wa.batumi-key.homes", "localhost", "127.0.0.1"]);
    if (crmBaseUrl) internal.add(new URL(crmBaseUrl).hostname.toLowerCase());
    if (internal.has(url.hostname.toLowerCase()) || url.hostname.endsWith(".internal")) return undefined;
    return value;
  } catch { return undefined; }
}

/**
 * Тонкий адаптер над owner-dialogue ядром: собирает вход (история, факты
 * листинга, агентство), вызывает модель через существующий LlmProvider и
 * переводит решение ядра в контракт сервиса. Реплику пишет только модель —
 * словарей заготовок и keyword-обработки да/нет здесь нет.
 */
export async function planCooperation(llm: LlmProvider, input: {
  history: HistoryEntry[]; batchText: string; listings: Listing[];
  contactListingCount?: number;
  interactions: CrmInteraction[]; instanceId: string;
  representativeName?: string; agencyName?: string; crmBaseUrl?: string;
  onRaw?: (raw: string) => Promise<void>;
}): Promise<CooperationResult> {
  const anchor = input.interactions.filter(row => row.direction === "outgoing" && row.instance_id === input.instanceId && row.notes?.startsWith("cooperation_outreach:v1:"))
    .sort((a,b) => String(a.sent_at).localeCompare(String(b.sent_at)) || String(a.id).localeCompare(String(b.id), undefined, {numeric:true})).at(-1);
  const sourceId = anchor?.notes?.slice("cooperation_outreach:v1:".length);
  const target = input.listings.find(row => String(row.id) === sourceId) ?? (!sourceId && input.listings.length === 1 ? input.listings[0] : undefined);

  // Планировщик зовёт модель «простым» вызовом, как гонка owner-dialogue (26/26):
  // JSON-режим провайдера у thinking-моделей (DeepSeek) официально даёт пустой
  // контент, а 600 токенов ядра уходят на reasoning. Бюджет поднят до 2000.
  const plannerLlm: LlmProvider = {
    complete: (messages, options) => llm.complete(messages, {
      ...options,
      maxTokens: Math.max(options?.maxTokens ?? 0, 2000),
      jsonMode: false,
    }),
  };

  let decision;
  try {
    decision = await planOwnerReply(plannerLlm, {
      agency: {
        name: input.agencyName?.trim() || "Batumi Key",
        representativeName: input.representativeName,
      },
      listing: target ? {
        address: target.address ?? undefined,
        url: publicListingUrl(target.url, input.crmBaseUrl),
        description: target.description ?? undefined,
      } : undefined,
      contactListingCount: Math.max(input.contactListingCount ?? 0, input.listings.length),
      facts: { knownClient: false },
      history: input.history.map(entry => ({
        role: entry.role === "assistant" ? "agent" as const : "owner" as const,
        text: entry.content,
      })),
      incoming: input.batchText,
    }, { onRaw: input.onRaw });
  } catch (error) {
    // Сбой провайдера уходит наверх как есть — очередь делает ретраи.
    if ((error as Error).name === "LlmError") throw error;
    throw new AgentOutputError((error as Error).message, "");
  }

  // Партнёры-TG исключаются из пула выше по конвейеру; страховка от
  // автоматического статуса realtor поверх одобренного партнёра.
  const partnerPresent = input.listings.some(row => (row.contact_type ?? "").toLowerCase() === "partner");
  const crmStatus = decision.crmStatus === "realtor" && partnerPresent ? null : decision.crmStatus;

  if (decision.action === "reply" || decision.action === "silence") {
    return {
      actions: [],
      reply: decision.action === "reply" ? decision.reply : "",
      stopConversation: false,
      ...(target ? { selectedListingId: target.id } : {}),
    };
  }

  // handoff и stop всегда молчаливые: собственнику не уходит ни слова,
  // только действия в CRM и (для handoff) ручной захват менеджером.
  const routing = crmStatus === "realtor" ? target ?? input.listings[0] : target;
  if (crmStatus && !routing) {
    return {
      actions: [], reply: "", stopConversation: true,
      handoffReason: `no_listing_for_status (${decision.crmStatus}): ${decision.reason}`,
    };
  }
  return {
    actions: crmStatus && routing ? [{ type: "set_crm_status", listingId: routing.id, status: crmStatus }] : [],
    reply: "",
    stopConversation: true,
    ...(routing ? { selectedListingId: routing.id } : {}),
    ...(decision.action === "handoff" ? { handoffReason: `owner_dialogue: ${decision.reason}` } : {}),
  };
}
