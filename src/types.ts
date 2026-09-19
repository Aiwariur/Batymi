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

export type CrmStatus = "agreed" | "qualified" | "disagreed";

export interface DealInfo {
  commission_type: string;
  commission_value: string;
  price_net: string;
  window_view: string;
  complex_name: string;
  cadastral_code: string;
  agent_notes: string;
}

export interface Flat {
  id: number | string;
  crm_status?: string | null;
  phone?: string | null;
  contact_name?: string | null;
  contact_type?: string | null;
  address?: string | null;
  district?: string | null;
  rooms?: number | string | null;
  area?: number | string | null;
  floor?: number | string | null;
  price?: number | string | null;
  currency?: string | null;
  url?: string | null;
  commission_type?: string | null;
  commission_value?: string | null;
  price_net?: string | null;
  window_view?: string | null;
  complex_name?: string | null;
  cadastral_code?: string | null;
  agent_notes?: string | null;
  assigned_manager_id?: number | string | null;
}

export interface CrmContext {
  phone: string;
  contact: {
    phone: string;
    contact_type?: string | null;
    name?: string | null;
  } | null;
  flats: Flat[];
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
