import { CrmClient, ResidentialComplex } from "../crm/crm.client";
import { DealInfoUpdate } from "../types";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { NO_COMPLEX_MARKERS } from "./gates";
import { AgentAction } from "./schemas";

export interface ActionExecutorContext {
  crm: CrmClient;
  logger: Logger;
  debug: DebugRecorder;
  phone: string;
  primaryListingId: string | number | null;
}

/** Маркеры «нет ЖК» не назначают residential_complex_id — только complex_name. */
export function isNoComplexMarker(name: string): boolean {
  return NO_COMPLEX_MARKERS.has(name.trim().toLowerCase());
}

/**
 * Матчинг ЖК по закрытому каталогу CRM: точное совпадение имени (без учёта
 * регистра/пробелов). Не найдено — оставляем только complex_name для ручной
 * проверки менеджером, id не выдумываем.
 */
export function matchComplex(
  complexes: ResidentialComplex[],
  name: string,
): ResidentialComplex | null {
  const wanted = name.trim().toLowerCase();
  if (!wanted || isNoComplexMarker(name)) return null;
  return (
    complexes.find((complex) => complex.name.trim().toLowerCase() === wanted) ?? null
  );
}

export async function executeActions(
  actions: AgentAction[],
  ctx: ActionExecutorContext,
): Promise<string[]> {
  const executed: string[] = [];

  const needsComplexMatch = actions.some(
    (action) =>
      action.type === "update_deal_info" &&
      action.data.complex_name !== undefined &&
      action.data.complex_name.trim() !== "",
  );
  let complexes: ResidentialComplex[] = [];
  if (needsComplexMatch) {
    try {
      complexes = await ctx.crm.getComplexes();
    } catch (error) {
      ctx.logger.warn({ err: (error as Error).message }, "action.complexes.unavailable");
    }
  }

  for (const action of actions) {
    switch (action.type) {
      case "set_contact_type": {
        await ctx.crm.setContactType(ctx.phone, action.contactType);
        ctx.debug.recordCrmAction("set_contact_type", { phone: ctx.phone, contactType: action.contactType });
        ctx.logger.info({ contactType: action.contactType }, "action.set_contact_type");
        executed.push("set_contact_type");
        break;
      }
      case "update_deal_info": {
        const listingId = action.listingId ?? ctx.primaryListingId;
        if (listingId === null || listingId === undefined) {
          ctx.logger.error("action.update_deal_info.no_listing");
          break;
        }
        const data: DealInfoUpdate = { ...action.data };
        if (data.complex_name && !isNoComplexMarker(data.complex_name)) {
          const match = matchComplex(complexes, data.complex_name);
          if (match) data.residential_complex_id = match.id;
        }
        await ctx.crm.updateDealInfo(ctx.phone, listingId, data);
        ctx.debug.recordCrmAction("update_deal_info", { phone: ctx.phone, listingId, data });
        ctx.logger.info({ listingId, fields: Object.keys(data) }, "action.update_deal_info");
        executed.push("update_deal_info");
        break;
      }
      case "update_rental_terms": {
        const listingId = action.listingId ?? ctx.primaryListingId;
        if (listingId === null || listingId === undefined) {
          ctx.logger.error("action.update_rental_terms.no_listing");
          break;
        }
        await ctx.crm.updateRentalTerms(ctx.phone, listingId, action.data);
        ctx.debug.recordCrmAction("update_rental_terms", {
          phone: ctx.phone,
          listingId,
          data: action.data,
        });
        ctx.logger.info({ listingId, fields: Object.keys(action.data) }, "action.update_rental_terms");
        executed.push("update_rental_terms");
        break;
      }
      case "set_crm_status": {
        const listingId = action.listingId ?? ctx.primaryListingId;
        if (listingId === null || listingId === undefined) {
          ctx.logger.error("action.set_crm_status.no_listing");
          break;
        }
        // Batymi's agreed transition starts phase 2 collection.  Suppress
        // CRM's legacy auto-publication hook for this request; operators and
        // other callers retain the old default when the flag is absent.
        await ctx.crm.setStatus(listingId, action.status, {
          suppressTelegram: action.status === "agreed",
        });
        ctx.debug.recordCrmAction("set_crm_status", { listingId, status: action.status });
        ctx.logger.info({ listingId, status: action.status }, "action.set_crm_status");
        executed.push("set_crm_status");
        break;
      }
    }
  }

  return executed;
}
