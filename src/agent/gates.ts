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
  selectedListingId?: string | number;
  contactListingCount?: number;
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
 * Минимум завершения разговора; публикация отдельно проверяется CRM readiness.
 * Проверяется по «склеенному» состоянию: CRM-данные + поля, которые LLM
 * пишет этими же действиями (update_deal_info / update_rental_terms).
 *
 * Комиссия, вид из окон, ЖК и кадастровый номер в гейт
 * сознательно НЕ входят: публикация их не требует, а диалог не должен
 * упираться в один неназванный ответ — недостающее агент фиксирует в
 * agent_notes, остальное доденет менеджер.
 */
export function qualifiedMissingFields(listing: Listing, futureAvailabilityConfirmed = false): string[] {
  const missing: string[] = [];
  const terms = listing.rental_terms ?? {};

  const price = Number(terms.price);
  if (!Number.isFinite(price) || price <= 0) missing.push("rental_terms.price");
  if (!isFilled(terms.currency)) missing.push("rental_terms.currency");
  if (terms.price_period !== "month") missing.push("rental_terms.price_period");
  const futureAvailability = terms.availability_status === "unknown" &&
    (isFilled(terms.available_from) || futureAvailabilityConfirmed && isFilled(terms.lease_terms_notes));
  if (terms.availability_status !== "available" && !futureAvailability) missing.push("rental_terms.availability_status");
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
 * Только целостность данных и адресация; смысл и следующий вопрос выбирает модель.
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
    // This reason belongs to the whole Contact; selecting an apartment must
    // not delay exclusion of a confirmed outside agent.
    const contactRealtorAction = action.type === "set_crm_status" && action.status === "realtor";
    if (!contactRealtorAction && actions.some(item => item.type === "set_crm_status" && item.status === "realtor")) {
      reject(action, "realtor_dialog_closed");
      continue;
    }
    if (!contactRealtorAction && (ctx.contactListingCount ?? ctx.listings.length) > 1 && (ctx.selectedListingId === undefined ||
      !listingIds.has(String(ctx.selectedListingId)))) {
      reject(action, "listing_selection_required");
      continue;
    }
    if (!contactRealtorAction && action.type !== "set_contact_type" && (ctx.contactListingCount ?? ctx.listings.length) > 1 &&
      String(action.listingId) !== String(ctx.selectedListingId)) {
      reject(action, "action_targets_unselected_listing");
      continue;
    }
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
        const existingTarget = statusAction.listingId ?? ctx.primaryListingId;
        if (findListing(ctx, existingTarget)?.crm_status === status) {
          reject(action, status === "agreed" ? "status_already_agreed" : "unchanged_crm_status");
          break;
        }
        if ((FORBIDDEN_AGENT_STATUSES as readonly string[]).includes(status)) {
          reject(action, "forbidden_status");
          break;
        }
        if (ctx.phase === "qualified") {
          reject(action, "qualified_dialog_no_actions");
          break;
        }
        if (ctx.phase === "agreed" && status === "agreed") {
          reject(action, "status_already_agreed");
          break;
        }
        const target = resolveListingId(statusAction.listingId ?? (status === "realtor" ? ctx.primaryListingId : undefined), ctx, listingIds);
        if ("reason" in target) {
          reject(action, target.reason);
          break;
        }
        if (findListing(ctx, target.listingId)?.crm_status === status) {
          reject(action, "unchanged_crm_status");
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
    if (action.type === "set_crm_status" && acceptedWrites.some(
      write => write.type === "update_rental_terms" && write.data.availability_status === "rented",
    )) {
      reject(action, "rented_dialog_closed");
      continue;
    }
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
    const missing = qualifiedMissingFields(merged, action.availabilityBasis === "future");
    const typeAction = [...allowed].reverse().find(item => item.type === "set_contact_type");
    const owner = typeAction?.type === "set_contact_type" ? typeAction.contactType : listing.contact_type;
    if (owner !== "owner") missing.push("owner");
    const consent = listing.crm_status === "agreed" || allowed.some(item => item.type === "set_crm_status" && item.status === "agreed");
    if (!consent) missing.push("cooperation");
    if ((ctx.contactListingCount ?? ctx.listings.length) > 1) missing.push("multi_listing_scope_requires_manager");
    if (allowed.some(item => item.type === "set_crm_status" && item.status === "disagreed")) missing.push("conflicting_refusal");
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
        (action) => action.type !== "set_crm_status",
      ),
      ...finalized.filter(action => action.type === "set_crm_status" && action.status !== "qualified"),
      ...qualifiedStatuses,
    ],
    rejected,
  };
}
