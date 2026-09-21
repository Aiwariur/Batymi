import { Config } from "../config/env";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import {
  ContactType,
  CrmStatus,
  DealInfoUpdate,
  Listing,
  RentalTerms,
  RentalTermsUpdate,
} from "../types";
import {
  complexesResponseSchema,
  contactResponseSchema,
  dealResponseSchema,
  listingsResponseSchema,
  rentalTermsResponseSchema,
  statusResponseSchema,
} from "./crm.schemas";

const REQUEST_TIMEOUT_MS = 15000;
const COMPLEXES_CACHE_TTL_MS = 10 * 60 * 1000;

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

export interface ResidentialComplex {
  id: number | string;
  name: string;
}

export interface CrmClient {
  getListingsByPhone(phone: string): Promise<Listing[]>;
  setStatus(listingId: string | number, status: CrmStatus): Promise<void>;
  setContactType(phone: string, contactType: ContactType): Promise<void>;
  updateDealInfo(phone: string, data: DealInfoUpdate): Promise<void>;
  updateRentalTerms(
    phone: string,
    listingId: string | number,
    data: RentalTermsUpdate,
  ): Promise<void>;
  getComplexes(): Promise<ResidentialComplex[]>;
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
  private complexesCache: { at: number; data: ResidentialComplex[] } | null = null;

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private get base(): string {
    if (!this.config.crmBaseUrl) throw new CrmError("CRM_BASE_URL is not configured", undefined, false);
    if (!this.config.crmApiKey) throw new CrmError("CRM_API_KEY is not configured", undefined, false);
    return this.config.crmBaseUrl;
  }

  async getListingsByPhone(phone: string): Promise<Listing[]> {
    const url = `${this.base}/flat/by-phone?phone=${encodeURIComponent(phone)}`;
    const { status, json } = await requestJson(url, { method: "GET" }, this.config.crmApiKey);
    assertOk(status, json);

    const parsed = listingsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError(
        `CRM listings response failed validation: ${parsed.error.issues.map((i) => i.path.join(".")).join(", ")}`,
        status,
        false,
      );
    }
    return parsed.data.flats as Listing[];
  }

  async setStatus(listingId: string | number, status: CrmStatus): Promise<void> {
    const url = `${this.base}/status/set`;
    const { status: httpStatus, json } = await requestJson(
      url,
      { method: "POST", body: JSON.stringify({ id: listingId, status }) },
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

  async updateDealInfo(phone: string, data: DealInfoUpdate): Promise<void> {
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

  async updateRentalTerms(
    phone: string,
    listingId: string | number,
    data: RentalTermsUpdate,
  ): Promise<void> {
    const url = `${this.base}/contacts/${encodeURIComponent(formatContactPhone(phone))}/listings/${encodeURIComponent(
      String(listingId),
    )}/rental-terms`;
    const { status, json } = await requestJson(
      url,
      { method: "POST", body: JSON.stringify(data) },
      this.config.crmApiKey,
    );
    assertOk(status, json);
    const parsed = rentalTermsResponseSchema.safeParse(json);
    if (!parsed.success) {
      throw new CrmError("CRM rental-terms response failed validation", status, false);
    }
  }

  async getComplexes(): Promise<ResidentialComplex[]> {
    if (this.complexesCache && Date.now() - this.complexesCache.at < COMPLEXES_CACHE_TTL_MS) {
      return this.complexesCache.data;
    }
    const url = `${this.base}/complexes`;
    const { status, json } = await requestJson(url, { method: "GET" }, this.config.crmApiKey);
    assertOk(status, json);
    const parsed = complexesResponseSchema.safeParse(json);
    if (!parsed.success || !parsed.data.complexes) {
      throw new CrmError("CRM complexes response failed validation", status, false);
    }
    const data = parsed.data.complexes as ResidentialComplex[];
    this.complexesCache = { at: Date.now(), data };
    return data;
  }
}

interface MockListingState {
  id: number;
  title: string;
  address: string;
  price: number | string | null;
  currency: string | null;
  windowView: string | null;
  cadastralCode: string | null;
  complexName: string | null;
  residentialComplexId: number | null;
  description: string | null;
  options: string[] | null;
  rental: RentalTerms;
}

interface MockContactState {
  contactType: ContactType;
  status: CrmStatus;
  managerId: number;
  listings: MockListingState[];
}

function mockListing(id: number, overrides: Partial<MockListingState> = {}): MockListingState {
  return {
    id,
    title: "2-комн. квартира, New Boulevard",
    address: "Batumi, Kobaladze St 24",
    price: 900,
    currency: "USD",
    windowView: null,
    cadastralCode: null,
    complexName: null,
    residentialComplexId: null,
    description:
      "Светлая квартира с ремонтом, балкон, кондиционер. В доме бассейн, спортзал и закрытая парковка.",
    options: ["Балкон", "Бассейн", "Спортзал", "Лифт"],
    rental: {
      listing_id: id,
      price: 900,
      currency: "USD",
      transaction_type: "rent_long_term",
      price_period: "month",
      deposit_amount: null,
      prepayment_months: null,
      minimum_lease_months: null,
      availability_status: "unknown",
      available_from: null,
      lease_terms_notes: null,
      commission_type: null,
      commission_value: null,
      commission_payer: "unknown",
      commission_notes: null,
      publication_consent: null,
    },
    ...overrides,
  };
}

function toListing(contact: MockContactState, listing: MockListingState, phone: string): Listing {
  return {
    id: listing.id,
    title: listing.title,
    crm_status: contact.status,
    phone,
    contact_name: "Mock Owner",
    contact_type: contact.contactType,
    address: listing.address,
    district: "New Boulevard",
    city: "Batumi",
    rooms: "2",
    area: "55",
    floor: "7",
    price: listing.price,
    currency: listing.currency,
    url: `https://example.com/flat/${listing.id}`,
    window_view: listing.windowView,
    complex_name: listing.complexName,
    residential_complex_id: listing.residentialComplexId,
    cadastral_code: listing.cadastralCode,
    description: listing.description,
    options: listing.options,
    agent_notes: null,
    assigned_manager_id: contact.managerId,
    is_active: true,
    rental_terms: { ...listing.rental },
  };
}

/**
 * Когерентный мок арендной CRM: статус живёт на контакте (все листинги
 * телефона показывают один crm_status), rental-термины — на листинге.
 * Тесты могут засеять состояние через setContactState.
 */
export class MockCrmClient implements CrmClient {
  private readonly contacts = new Map<string, MockContactState>();

  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
    private readonly debug: DebugRecorder,
  ) {}

  /** Сидирование состояния для тестов/debug-сценариев. */
  setContactState(phone: string, patch: Partial<MockContactState> & { listings?: Partial<MockListingState>[] }): void {
    const key = formatContactPhone(phone);
    const current =
      this.contacts.get(key) ??
      ({
        contactType: "potential_owner",
        status: "delivered",
        managerId: this.config.allowedManagerIds[0] ?? 2,
        listings: [mockListing(101)],
      } as MockContactState);
    const next: MockContactState = {
      ...current,
      ...patch,
      listings:
        patch.listings?.map((partial, index) => {
          const base = current.listings[index] ?? mockListing(101 + index);
          return { ...base, ...partial, rental: { ...base.rental, ...(partial.rental ?? {}) } };
        }) ?? current.listings,
    };
    this.contacts.set(key, next);
  }

  private stateFor(phone: string): MockContactState {
    const key = formatContactPhone(phone);
    let state = this.contacts.get(key);
    if (!state) {
      state = {
        contactType: "potential_owner",
        status: "delivered",
        managerId: this.config.allowedManagerIds[0] ?? 2,
        listings: [mockListing(101)],
      };
      this.contacts.set(key, state);
    }
    return state;
  }

  async getListingsByPhone(phone: string): Promise<Listing[]> {
    const key = formatContactPhone(phone);
    const state = this.stateFor(phone);
    this.logger.debug({ phone: key, count: state.listings.length }, "crm.mock.getListingsByPhone");
    return state.listings.map((listing) => toListing(state, listing, key));
  }

  async setStatus(listingId: string | number, status: CrmStatus): Promise<void> {
    const target = String(listingId);
    for (const [phone, state] of this.contacts) {
      if (state.listings.some((listing) => String(listing.id) === target)) {
        state.status = status;
        this.debug.recordCrmAction("set_crm_status", { phone, listingId, status });
        this.logger.debug({ phone, listingId, status }, "crm.mock.setStatus");
        return;
      }
    }
    this.debug.recordCrmAction("set_crm_status", { listingId, status, missed: true });
    this.logger.debug({ listingId, status }, "crm.mock.setStatus.unknown_listing");
  }

  async setContactType(phone: string, contactType: ContactType): Promise<void> {
    const state = this.stateFor(phone);
    state.contactType = contactType;
    this.debug.recordCrmAction("set_contact_type", { phone, contactType });
    this.logger.debug({ phone, contactType }, "crm.mock.setContactType");
  }

  async updateDealInfo(phone: string, data: DealInfoUpdate): Promise<void> {
    const state = this.stateFor(phone);
    const listing = state.listings[0];
    if (listing) {
      if (data.window_view !== undefined) listing.windowView = data.window_view;
      if (data.cadastral_code !== undefined) listing.cadastralCode = data.cadastral_code;
      if (data.complex_name !== undefined) listing.complexName = data.complex_name;
      if (data.residential_complex_id !== undefined) {
        listing.residentialComplexId = Number(data.residential_complex_id) || null;
      }
    }
    this.debug.recordCrmAction("update_deal_info", { phone, data });
    this.logger.debug({ phone }, "crm.mock.updateDealInfo");
  }

  async updateRentalTerms(
    phone: string,
    listingId: string | number,
    data: RentalTermsUpdate,
  ): Promise<void> {
    const state = this.stateFor(phone);
    const listing = state.listings.find((item) => String(item.id) === String(listingId));
    if (!listing) {
      this.debug.recordCrmAction("update_rental_terms", { phone, listingId, data, missed: true });
      return;
    }
    listing.rental = { ...listing.rental, ...data, listing_id: listing.id };
    this.debug.recordCrmAction("update_rental_terms", { phone, listingId, data });
    this.logger.debug({ phone, listingId }, "crm.mock.updateRentalTerms");
  }

  async getComplexes(): Promise<ResidentialComplex[]> {
    return [
      { id: 1, name: "Orbi City" },
      { id: 2, name: "Batumi Towers" },
      { id: 3, name: "Blue Ocean" },
    ];
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
