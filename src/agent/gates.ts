import { ConversationPhase, Listing, RentalTermsUpdate } from "../types";
import {
  AgentAction,
  SetCrmStatusAction,
  UpdateDealInfoAction,
  UpdateRentalTermsAction,
} from "./schemas";

export interface GateContext {
  listings: Listing[];
  primaryListingId: string | number;
  phase: ConversationPhase;
}

export interface RejectedAction {
  action: AgentAction;
  reason: string;
}

export interface GateResult {
  allowed: AgentAction[];
  rejected: RejectedAction[];
}

/** Статусы, которые движок никогда не выставляет сам (их ставит CRM). */
export const FORBIDDEN_AGENT_STATUSES = [
  "new",
  "sent",
  "delivered",
  "read",
  "sold",
  "archived",
  "no_whatsapp",
  "listing_removed",
] as const;

/** Маркеры «квартира не в ЖК» из контракта /deal арендной CRM. */
export const NO_COMPLEX_MARKERS = new Set(["нет жк", "не в жк", "-", "без жк"]);

function isFilled(value: unknown): boolean {
  return value !== undefined && value !== null && String(value).trim() !== "";
}

const hasText = (value: string | undefined): value is string =>
  value !== undefined && value.trim() !== "";

/**
 * Полнота фазы 2: минимум, без которого объявление нельзя публиковать.
 * Проверяется по «склеенному» состоянию: CRM-данные + поля, которые LLM
 * пишет этими же действиями (update_deal_info / update_rental_terms).
 *
 * Комиссия, вид из окон, ЖК, кадастровый номер и publication_consent в гейт
 * сознательно НЕ входят: публикация их не требует, а диалог не должен
 * упираться в один неназванный ответ — недостающее агент фиксирует в
 * agent_notes, остальное доденет менеджер.
 */
export function qualifiedMissingFields(listing: Listing): string[] {
  const missing: string[] = [];
  const terms = listing.rental_terms ?? {};

  const price = Number(terms.price);
  if (!Number.isFinite(price) || price <= 0) missing.push("rental_terms.price");
  if (!isFilled(terms.currency)) missing.push("rental_terms.currency");
  if (terms.price_period !== "month") missing.push("rental_terms.price_period");
  if (terms.transaction_type !== "rent_long_term") missing.push("rental_terms.transaction_type");
  if (terms.availability_status !== "available") missing.push("rental_terms.availability_status");
  const minimumLeaseMonths = Number(terms.minimum_lease_months);
  if (!Number.isFinite(minimumLeaseMonths) || minimumLeaseMonths <= 0) {
    missing.push("rental_terms.minimum_lease_months");
  }

  return missing;
}

/** Накатывает действия записи поверх CRM-состояния (для проверки qualified). */
export function mergeActionsOntoListing(
  listing: Listing,
  actions: AgentAction[],
  listingId: string | number,
): Listing {
  const merged: Listing = {
    ...listing,
    rental_terms: { ...(listing.rental_terms ?? {}) },
  };
  const id = String(listingId);

  for (const action of actions) {
    if (action.type === "update_deal_info") {
      if (action.listingId !== undefined && String(action.listingId) !== id) continue;
      if (isFilled(action.data.window_view)) merged.window_view = action.data.window_view;
      if (isFilled(action.data.cadastral_code)) merged.cadastral_code = action.data.cadastral_code;
      if (isFilled(action.data.complex_name)) merged.complex_name = action.data.complex_name;
    }
    if (action.type === "update_rental_terms") {
      const target = action.listingId !== undefined ? String(action.listingId) : id;
      if (target !== id) continue;
      merged.rental_terms = { ...merged.rental_terms, ...action.data };
    }
  }

  return merged;
}

function sanitizeDealInfo(action: UpdateDealInfoAction): UpdateDealInfoAction | null {
  const data: UpdateDealInfoAction["data"] = {};
  if (hasText(action.data.window_view)) data.window_view = action.data.window_view.trim();
  if (hasText(action.data.cadastral_code)) data.cadastral_code = action.data.cadastral_code.trim();
  if (hasText(action.data.complex_name)) data.complex_name = action.data.complex_name.trim();
  if (hasText(action.data.agent_notes)) data.agent_notes = action.data.agent_notes.trim();
  if (Object.keys(data).length === 0) return null;
  return { type: "update_deal_info", listingId: action.listingId, data };
}

function sanitizeRentalTerms(action: UpdateRentalTermsAction): UpdateRentalTermsAction | null {
  const data: RentalTermsUpdate = {};
  const source = action.data as Record<string, unknown>;
  for (const [key, value] of Object.entries(source)) {
    if (value === undefined || value === null) continue;
    if (typeof value === "string" && value.trim() === "") continue;
    (data as Record<string, unknown>)[key] =
      typeof value === "string" && key !== "lease_terms_notes" && key !== "commission_notes"
        ? value.trim()
        : value;
  }
  if (Object.keys(data).length === 0) return null;
  return { type: "update_rental_terms", listingId: action.listingId, data };
}

function resolveListingId(
  listingId: string | number | undefined,
  ctx: GateContext,
  listingIds: Set<string>,
): { listingId: string | number } | { reason: string } {
  if (listingId === undefined) {
    if (ctx.listings.length > 1) {
      return { reason: "listing_id_required_for_multiple_listings" };
    }
    return { listingId: ctx.primaryListingId };
  }
  if (!listingIds.has(String(listingId))) return { reason: "unknown_listing_id" };
  return { listingId };
}

function findListing(ctx: GateContext, listingId: string | number): Listing | undefined {
  return ctx.listings.find((listing) => String(listing.id) === String(listingId));
}

/**
 * Совпадение записываемого значения с текущим значением CRM: числа сравниваются
 * численно (900 === "900.00"), остальное — по обрезанной строке. LLM любит
 * пересылать уже записанный пакет условий целиком — такие записи не нужны.
 */
function sameStoredValue(current: unknown, incoming: unknown): boolean {
  const norm = (value: unknown) =>
    value === undefined || value === null ? null : String(value).trim();
  const a = norm(current);
  const b = norm(incoming);
  if (a === null || b === null) return a === b;
  if (a === b) return true;
  const na = Number(a.replace(",", "."));
  const nb = Number(b.replace(",", "."));
  return Number.isFinite(na) && Number.isFinite(nb) && na === nb;
}

function dropUnchangedDealFields(
  listing: Listing | undefined,
  data: UpdateDealInfoAction["data"],
): UpdateDealInfoAction["data"] {
  const current: Record<string, unknown> = listing
    ? {
        window_view: listing.window_view,
        cadastral_code: listing.cadastral_code,
        complex_name: listing.complex_name,
        agent_notes: listing.agent_notes,
      }
    : {};
  const diff: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(data)) {
    if (!sameStoredValue(current[key], value)) diff[key] = value;
  }
  return diff as UpdateDealInfoAction["data"];
}

function dropUnchangedRentalFields(
  listing: Listing | undefined,
  data: RentalTermsUpdate,
): RentalTermsUpdate {
  const terms = (listing?.rental_terms ?? {}) as Record<string, unknown>;
  const diff: RentalTermsUpdate = {};
  for (const [key, value] of Object.entries(data)) {
    if (!sameStoredValue(terms[key], value)) (diff as Record<string, unknown>)[key] = value;
  }
  return diff;
}

/**
 * Детерминированные гейты поверх действий LLM — до любого вызова CRM.
 * Каждое правило дублирует системный промпт (system-prompt.ts), но проверяется
 * кодом, а не промптом.
 */
export function applyGates(actions: AgentAction[], ctx: GateContext): GateResult {
  const allowed: AgentAction[] = [];
  const rejected: RejectedAction[] = [];
  const reject = (action: AgentAction, reason: string) => rejected.push({ action, reason });

  const listingIds = new Set(ctx.listings.map((listing) => String(listing.id)));

  // First normalize and target every write.  Qualification is checked in a
  // second pass so an LLM cannot qualify before a later write in the same
  // batch, and rejected/unscoped actions cannot contribute to completeness.
  for (const action of actions) {
    switch (action.type) {
      case "set_contact_type": {
        if (ctx.phase === "qualified") {
          reject(action, "qualified_dialog_no_actions");
          break;
        }
        const currentTypes = new Set(
          ctx.listings.map((listing) => (listing.contact_type ?? "").toLowerCase()),
        );
        if (currentTypes.size === 1 && currentTypes.has(action.contactType.toLowerCase())) {
          reject(action, "unchanged_contact_type");
          break;
        }
        allowed.push(action);
        break;
      }

      case "update_deal_info": {
        if (ctx.phase === "qualified") {
          reject(action, "qualified_dialog_no_actions");
          break;
        }
        const target = resolveListingId(action.listingId, ctx, listingIds);
        if ("reason" in target) {
          reject(action, target.reason);
          break;
        }
        const sanitized = sanitizeDealInfo(action);
        if (!sanitized) {
          reject(action, "no_fields_to_write");
          break;
        }
        const deduped = dropUnchangedDealFields(findListing(ctx, target.listingId), sanitized.data);
        if (Object.keys(deduped).length === 0) {
          reject(action, "no_changes_vs_crm");
          break;
        }
        allowed.push({ ...sanitized, listingId: target.listingId, data: deduped });
        break;
      }

      case "update_rental_terms": {
        if (ctx.phase === "qualified") {
          reject(action, "qualified_dialog_no_actions");
          break;
        }
        const target = resolveListingId(action.listingId, ctx, listingIds);
        if ("reason" in target) {
          reject(action, target.reason);
          break;
        }
        const sanitized = sanitizeRentalTerms(action);
        if (!sanitized) {
          reject(action, "no_fields_to_write");
          break;
        }
        const deduped = dropUnchangedRentalFields(findListing(ctx, target.listingId), sanitized.data);
        if (Object.keys(deduped).length === 0) {
          reject(action, "no_changes_vs_crm");
          break;
        }
        allowed.push({ ...sanitized, listingId: target.listingId, data: deduped });
        break;
      }

      case "set_crm_status": {
        const statusAction = action as SetCrmStatusAction;
        const status = statusAction.status;
        if ((FORBIDDEN_AGENT_STATUSES as readonly string[]).includes(status)) {
          reject(action, "forbidden_status");
          break;
        }
        if (ctx.phase === "qualified") {
          reject(action, "qualified_dialog_no_actions");
          break;
        }
        if (ctx.phase === "primary" && status === "qualified") {
          reject(action, "qualified_not_in_primary_phase");
          break;
        }
        const target = resolveListingId(statusAction.listingId, ctx, listingIds);
        if ("reason" in target) {
          reject(action, target.reason);
          break;
        }
        allowed.push({ ...statusAction, listingId: target.listingId });
        break;
      }
    }
  }

  // Only sanitized actions accepted above may fill the qualification state.
  // Keep qualified status writes after all data writes so CRM state cannot
  // become qualified while one of its same-batch updates is still pending.
  const acceptedWrites = allowed.filter(
    (action) => action.type === "update_deal_info" || action.type === "update_rental_terms",
  );
  const finalized: AgentAction[] = [];
  for (const action of allowed) {
    if (action.type !== "set_crm_status" || action.status !== "qualified") {
      finalized.push(action);
      continue;
    }
    const listing = ctx.listings.find((item) => String(item.id) === String(action.listingId));
    if (!listing) {
      reject(action, "unknown_listing_id");
      continue;
    }
    const merged = mergeActionsOntoListing(listing, acceptedWrites, action.listingId!);
    const missing = qualifiedMissingFields(merged);
    if (missing.length > 0) {
      reject(action, `qualified_incomplete:${missing.join(",")}`);
      continue;
    }
    finalized.push(action);
  }

  const qualifiedStatuses = finalized.filter(
    (action) => action.type === "set_crm_status" && action.status === "qualified",
  );
  return {
    allowed: [
      ...finalized.filter(
        (action) => !(action.type === "set_crm_status" && action.status === "qualified"),
      ),
      ...qualifiedStatuses,
    ],
    rejected,
  };
}
