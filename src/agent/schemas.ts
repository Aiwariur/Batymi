import { z } from "zod";
import {
  AgentCrmStatus,
  ContactType,
  DealInfoUpdate,
  RentalAvailabilityStatus,
  RentalCommissionPayer,
  RentalCommissionType,
  RentalTermsUpdate,
} from "../types";

const lower = (value: unknown) => (typeof value === "string" ? value.trim().toLowerCase() : value);

export const contactTypeSchema = z.preprocess(
  lower,
  z.enum(["owner", "realtor", "potential_owner"]),
) as unknown as z.ZodType<ContactType>;

/** Полный словарь crm_status арендной CRM (для чтения/гейтов). */
export const crmStatusSchema = z.preprocess(
  lower,
  z.enum([
    "new",
    "sent",
    "delivered",
    "read",
    "agreed",
    "qualified",
    "disagreed",
    "sold",
    "archived",
    "no_whatsapp",
    "listing_removed",
  ]),
) as unknown as z.ZodType<import("../types").CrmStatus>;

/** Только эти статусы LLM вправе выставить через set_crm_status. */
export const agentCrmStatusSchema = z.preprocess(
  lower,
  z.enum(["agreed", "qualified", "disagreed"]),
) as unknown as z.ZodType<AgentCrmStatus>;

const nonEmptyTrimmed = z
  .string()
  .transform((value) => value.trim())
  .refine((value) => value.length > 0, { message: "пустая строка" });

/** Объектные поля листинга; передаются только выясненные, пустые отбрасываются гейтом. */
export const dealInfoSchema = z.object({
  window_view: z.string().optional(),
  cadastral_code: z.string().optional(),
  complex_name: z.string().optional(),
  agent_notes: z.string().optional(),
});

const coerceNum = (value: unknown) => {
  if (typeof value === "string" && value.trim() !== "" && Number.isFinite(Number(value))) {
    return Number(value);
  }
  return value;
};

const intRange = (min: number, max: number) =>
  z.preprocess(coerceNum, z.number().int().min(min).max(max));

const decimalString = z.preprocess((value) => {
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return value;
}, z.string());

/**
 * Арендные условия листинга. Семантика эндпоинта CRM: отсутствующее/пустое
 * поле — no-op, поэтому LLM передаёт только то, что реально назвал собственник.
 * transaction_type/price_period движок не пишет — их доказывают парсеры.
 */
export const rentalTermsDataSchema = z
  .object({
    // A zero price is not a usable long-term rent offer. Do not let an LLM
    // overwrite a real CRM price with a placeholder value.
    price: intRange(1, 2_147_483_647).optional(),
    currency: z.preprocess((v) => (typeof v === "string" ? v.trim().toUpperCase() : v), z.string().regex(/^[A-Z]{3}$/)).optional(),
    deposit_amount: intRange(0, 2_147_483_647).optional(),
    prepayment_months: intRange(0, 120).optional(),
    minimum_lease_months: intRange(1, 120).optional(),
    availability_status: z.preprocess(lower, z.enum(["unknown", "available", "reserved", "rented", "withdrawn"])).optional(),
    // Dates from natural language are not normalized here. Store phrases such
    // as "с октября" in lease_terms_notes instead of writing an invalid date.
    lease_terms_notes: z.string().optional(),
    commission_type: z.preprocess(lower, z.enum(["fixed", "percent_month", "months"])).optional(),
    commission_value: decimalString.optional(),
    commission_payer: z.preprocess(lower, z.enum(["owner", "tenant", "split", "unknown"])).optional(),
    commission_notes: z.string().optional(),
  })
  .strict();

export const setContactTypeActionSchema = z.object({
  type: z.literal("set_contact_type"),
  contactType: contactTypeSchema,
});

export const updateDealInfoActionSchema = z.object({
  type: z.literal("update_deal_info"),
  listingId: z.union([z.string(), z.number()]).optional(),
  data: dealInfoSchema,
});

export const updateRentalTermsActionSchema = z.object({
  type: z.literal("update_rental_terms"),
  listingId: z.union([z.string(), z.number()]).optional(),
  data: rentalTermsDataSchema,
});

export const setCrmStatusActionSchema = z.object({
  type: z.literal("set_crm_status"),
  status: agentCrmStatusSchema,
  listingId: z.union([z.string(), z.number()]).optional(),
});

export const actionSchema = z.discriminatedUnion("type", [
  setContactTypeActionSchema,
  updateDealInfoActionSchema,
  updateRentalTermsActionSchema,
  setCrmStatusActionSchema,
]);

export const agentResultSchema = z.object({
  reply: z.string().default(""),
  actions: z.array(actionSchema).default([]),
  stopConversation: z.boolean().default(false),
});

export type AgentAction = z.infer<typeof actionSchema>;
export type AgentResult = z.infer<typeof agentResultSchema>;
export type SetContactTypeAction = z.infer<typeof setContactTypeActionSchema>;
export type UpdateDealInfoAction = z.infer<typeof updateDealInfoActionSchema>;
export type UpdateRentalTermsAction = z.infer<typeof updateRentalTermsActionSchema>;
export type SetCrmStatusAction = z.infer<typeof setCrmStatusActionSchema>;
export type RentalTermsData = RentalTermsUpdate;

export function emptyDealInfo(): DealInfoUpdate {
  return {};
}
