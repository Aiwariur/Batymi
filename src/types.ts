export type MessageType = "text" | "audio" | "image" | "document" | "unsupported";

export interface NormalizedMessage {
  instanceId: string;
  idMessage: string;
  chatId: string;
  senderPhone: string;
  type: MessageType;
  text?: string;
  fileUrl?: string;
  timestamp: number;
  rawType: string;
}

export interface HistoryEntry {
  role: "user" | "assistant";
  content: string;
  ts: number;
}

export type ContactType = "owner" | "realtor" | "potential_owner";

/**
 * Полный словарь crm_status арендной CRM (Contact.crm_status).
 * Движок сам выставляет только agreed | qualified | disagreed;
 * остальные статусы ставятся CRM (broadcast, checker, авто-архивация).
 */
export type CrmStatus =
  | "new"
  | "sent"
  | "delivered"
  | "read"
  | "agreed"
  | "qualified"
  | "disagreed"
  | "sold"
  | "archived"
  | "no_whatsapp"
  | "listing_removed";

/** Статусы, доступные LLM-агенту через set_crm_status. */
export type AgentCrmStatus = "agreed" | "qualified" | "disagreed";

/**
 * Фаза диалога по crm_status:
 * - primary  — new/sent/delivered/read: первичная квалификация до agreed;
 * - agreed   — сбор арендных условий до qualified;
 * - qualified — данные собраны: содержательные ответы без действий.
 */
export type ConversationPhase = "primary" | "agreed" | "qualified";

export type RentalCommissionType = "fixed" | "percent_month" | "months";
export type RentalCommissionPayer = "owner" | "tenant" | "split" | "unknown";
export type RentalAvailabilityStatus =
  | "unknown"
  | "available"
  | "reserved"
  | "rented"
  | "withdrawn";

/** Вложенный rental_terms листинга из GET /api/flat/by-phone. */
export interface RentalTerms {
  listing_id?: number | string | null;
  price?: number | string | null;
  currency?: string | null;
  transaction_type?: string | null;
  price_period?: string | null;
  deposit_amount?: number | string | null;
  prepayment_months?: number | string | null;
  minimum_lease_months?: number | string | null;
  availability_status?: string | null;
  available_from?: string | null;
  lease_terms_notes?: string | null;
  commission_type?: string | null;
  commission_value?: string | null;
  commission_payer?: string | null;
  commission_notes?: string | null;
  publication_consent?: boolean | null;
}

/** Payload для POST /api/contacts/<phone>/listings/<id>/rental-terms. */
export interface RentalTermsUpdate {
  price?: number;
  currency?: string;
  deposit_amount?: number;
  prepayment_months?: number;
  minimum_lease_months?: number;
  availability_status?: RentalAvailabilityStatus;
  available_from?: string;
  lease_terms_notes?: string;
  commission_type?: RentalCommissionType;
  commission_value?: string;
  commission_payer?: RentalCommissionPayer;
  commission_notes?: string;
  publication_consent?: boolean;
}

/** Payload для POST /api/contacts/<phone>/deal (объектные поля листинга). */
export interface DealInfoUpdate {
  window_view?: string;
  cadastral_code?: string;
  complex_name?: string;
  residential_complex_id?: number | string;
  agent_notes?: string;
}

export interface Listing {
  id: number | string;
  title?: string | null;
  crm_status?: string | null;
  phone?: string | null;
  contact_name?: string | null;
  contact_type?: string | null;
  address?: string | null;
  district?: string | null;
  city?: string | null;
  rooms?: number | string | null;
  area?: number | string | null;
  floor?: number | string | null;
  price?: number | string | null;
  currency?: string | null;
  url?: string | null;
  window_view?: string | null;
  complex_name?: string | null;
  residential_complex_id?: number | string | null;
  cadastral_code?: string | null;
  /** Текст объявления собственника из источника (парсер). */
  description?: string | null;
  /** Удобства/опции объявления из источника (массив или JSON-строка). */
  options?: string[] | string | null;
  agent_notes?: string | null;
  assigned_manager_id?: number | string | null;
  is_active?: boolean | null;
  rental_terms?: RentalTerms | null;
}

export interface CrmContext {
  phone: string;
  contact: {
    phone: string;
    contact_type?: string | null;
    name?: string | null;
  } | null;
  listings: Listing[];
}

export interface OutgoingMessage {
  instanceId: string;
  chatId: string;
  message: string;
  ts: number;
  mocked: boolean;
}

export interface CrmActionRecord {
  ts: number;
  action: string;
  payload: unknown;
}

export interface ForwardedWebhookRecord {
  ts: number;
  instanceId: string;
  payload: unknown;
}
