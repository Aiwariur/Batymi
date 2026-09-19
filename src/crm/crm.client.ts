import { Config } from "../config/env";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { ContactType, CrmStatus, DealInfo, Flat } from "../types";
import {
  contactResponseSchema,
  dealResponseSchema,
  flatsResponseSchema,
  statusResponseSchema,
} from "./crm.schemas";

const REQUEST_TIMEOUT_MS = 15000;

export class CrmError extends Error {
  constructor(
    message: string,
    readonly status?: number,
    readonly retryable = false,
  ) {
    super(message);
    this.name = "CrmError";
  }
}

export interface CrmClient {
  getFlatsByPhone(phone: string): Promise<Flat[]>;
  setStatus(flatId: string | number, status: CrmStatus): Promise<void>;
  setContactType(phone: string, contactType: ContactType): Promise<void>;
  updateDealInfo(phone: string, data: DealInfo): Promise<void>;
}

export function formatContactPhone(phone: string): string {
  if (phone.startsWith("+")) return phone;
  const digits = phone.replace(/[^\d]/g, "");
  return `+${digits}`;
}

async function requestJson(
  url: string,
  init: RequestInit,
  apiKey: string,
): Promise<{ status: number; json: unknown }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(url, {
      ...init,
      headers: {
        "Content-Type": "application/json",
        "X-API-Key": apiKey,
        ...(init.headers ?? {}),
      },
      signal: controller.signal,
    });
    const text = await response.text();
    let json: unknown = undefined;
    if (text) {
      try {
        json = JSON.parse(text);
      } catch {
        json = text;
      }
    }
    return { status: response.status, json };
  } catch (error) {
    throw new CrmError(`CRM request failed: ${(error as Error).message}`, undefined, true);
  } finally {
    clearTimeout(timer);
  }
}

function assertOk(status: number, json: unknown): void {
  if (status === 429 || status >= 500) {
    throw new CrmError(`CRM temporary failure: HTTP ${status}`, status, true);
  }
  if (status < 200 || status >= 300) {
    throw new CrmError(`CRM request failed: HTTP ${status}`, status, false);
  }
  if (json === undefined) {
    throw new CrmError("CRM returned an empty response", status, false);
  }
}

export class RealCrmClient implements CrmClient {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private get base(): string {
    if (!this.config.crmBaseUrl) throw new CrmError("CRM_BASE_URL is not configured", undefined, false);
    if (!this.config.crmApiKey) throw new CrmError("CRM_API_KEY is not configured", undefined, false);
    return this.config.crmBaseUrl;
  }

  async getFlatsByPhone(phone: string): Promise<Flat[]> {
    const url = `${this.base}/flat/by-phone?phone=${encodeURIComponent(phone)}`;
    const { status, json } = await requestJson(url, { method: "GET" }, this.config.crmApiKey);
    assertOk(status, json);

    const parsed = flatsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError(
        `CRM flats response failed validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        status,
        false,
      );
    }
    return parsed.data.flats as Flat[];
  }

  async setStatus(flatId: string | number, status: CrmStatus): Promise<void> {
    const url = `${this.base}/status/set`;
    const { status: httpStatus, json } = await requestJson(
      url,
      { method: "POST", body: JSON.stringify({ id: flatId, status }) },
      this.config.crmApiKey,
    );
    assertOk(httpStatus, json);
    const parsed = statusResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError("CRM status response failed validation", httpStatus, false);
    }
  }

  async setContactType(phone: string, contactType: ContactType): Promise<void> {
    const url = `${this.base}/contacts/${encodeURIComponent(formatContactPhone(phone))}/type`;
    const { status, json } = await requestJson(
      url,
      { method: "POST", body: JSON.stringify({ contact_type: contactType }) },
      this.config.crmApiKey,
    );
    assertOk(status, json);
    const parsed = contactResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError("CRM contact response failed validation", status, false);
    }
  }

  async updateDealInfo(phone: string, data: DealInfo): Promise<void> {
    const url = `${this.base}/contacts/${encodeURIComponent(formatContactPhone(phone))}/deal`;
    const { status, json } = await requestJson(
      url,
      { method: "POST", body: JSON.stringify(data) },
      this.config.crmApiKey,
    );
    assertOk(status, json);
    const parsed = dealResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError("CRM deal response failed validation", status, false);
    }
  }
}

interface MockContactState {
  contactType?: ContactType;
  status?: CrmStatus;
  deal?: DealInfo;
}

export class MockCrmClient implements CrmClient {
  private readonly contacts = new Map<string, MockContactState>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly debug: DebugRecorder,
  ) {}

  async getFlatsByPhone(phone: string): Promise<Flat[]> {
    const managerId = this.config.allowedManagerIds[0] ?? 2;
    const flat: Flat = {
      id: 123,
      crm_status: "delivered",
      phone: formatContactPhone(phone),
      contact_name: "Mock Owner",
      contact_type: this.contacts.get(phone)?.contactType ?? "potential_owner",
      address: "Batumi, Mock street 1",
      district: "Center",
      rooms: "2",
      area: "55",
      floor: "7",
      price: "90000",
      currency: "USD",
      url: "https://example.com/flat/123",
      commission_type: null,
      commission_value: null,
      price_net: null,
      window_view: null,
      complex_name: null,
      cadastral_code: null,
      agent_notes: null,
      assigned_manager_id: managerId,
    };
    this.logger.debug({ phone, flatId: flat.id }, "crm.mock.getFlatsByPhone");
    return [flat];
  }

  async setStatus(flatId: string | number, status: CrmStatus): Promise<void> {
    const state = this.contacts.get(String(flatId)) ?? {};
    state.status = status;
    this.contacts.set(String(flatId), state);
    this.debug.recordCrmAction("set_crm_status", { flatId, status });
    this.logger.debug({ flatId, status }, "crm.mock.setStatus");
  }

  async setContactType(phone: string, contactType: ContactType): Promise<void> {
    const state = this.contacts.get(phone) ?? {};
    state.contactType = contactType;
    this.contacts.set(phone, state);
    this.debug.recordCrmAction("set_contact_type", { phone, contactType });
    this.logger.debug({ phone, contactType }, "crm.mock.setContactType");
  }

  async updateDealInfo(phone: string, data: DealInfo): Promise<void> {
    const state = this.contacts.get(phone) ?? {};
    state.deal = data;
    this.contacts.set(phone, state);
    this.debug.recordCrmAction("update_deal_info", { phone, data });
    this.logger.debug({ phone }, "crm.mock.updateDealInfo");
  }
}

export function createCrmClient(
  config: Config,
  logger: Logger,
  debug: DebugRecorder,
): CrmClient {
  return config.mockCrm
    ? new MockCrmClient(config, logger, debug)
    : new RealCrmClient(config, logger);
}
