import { z } from "zod";

const optionalString = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : String(value)));

const optionalBool = z
  .union([z.boolean(), z.number(), z.string(), z.null()])
  .optional()
  .transform((value) => {
    if (value === undefined || value === null || value === "") return null;
    if (typeof value === "boolean") return value;
    if (value === 1 || value === "1" || value === "true") return true;
    if (value === 0 || value === "0" || value === "false") return false;
    return null;
  });

/** rental_terms — вложенный объект serialize_rental_terms() из арендной CRM. */
export const rentalTermsSchema = z
  .object({
    listing_id: z.union([z.string(), z.number(), z.null()]).optional(),
    price: z.union([z.string(), z.number(), z.null()]).optional(),
    currency: optionalString,
    transaction_type: optionalString,
    price_period: optionalString,
    deposit_amount: z.union([z.string(), z.number(), z.null()]).optional(),
    prepayment_months: z.union([z.string(), z.number(), z.null()]).optional(),
    minimum_lease_months: z.union([z.string(), z.number(), z.null()]).optional(),
    availability_status: optionalString,
    available_from: optionalString,
    lease_terms_notes: optionalString,
    commission_type: optionalString,
    commission_value: optionalString,
    commission_payer: optionalString,
    commission_notes: optionalString,
    publication_consent: optionalBool,
  })
  .passthrough();

export const listingSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    external_id: z.union([z.string(), z.number()]).optional(),
    title: optionalString,
    crm_status: optionalString,
    phone: optionalString,
    contact_name: optionalString,
    contact_type: optionalString,
    address: optionalString,
    district: optionalString,
    city: optionalString,
    rooms: optionalString,
    area: optionalString,
    floor: optionalString,
    price: optionalString,
    currency: optionalString,
    url: optionalString,
    window_view: optionalString,
    complex_name: optionalString,
    residential_complex_id: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((value) => (value === undefined || value === null ? null : value)),
    cadastral_code: optionalString,
    description: optionalString,
    options: z
      .union([z.array(z.union([z.string(), z.number(), z.boolean(), z.record(z.unknown())])), z.string(), z.record(z.unknown()), z.null()])
      .optional()
      .transform((value): string[] | string | null => {
        if (value === undefined || value === null) return null;
        // CRM хранит удобства как JSON-словарь {"wifi": true, ...} —
        // превращаем в список включённых ключей
        if (!Array.isArray(value) && typeof value === "object") {
          return Object.entries(value as Record<string, unknown>)
            .filter(([, v]) => v === true || v === "true" || v === 1 || v === "1" || (typeof v === "string" && v.trim() !== ""))
            .map(([k, v]) => (typeof v === "string" && v !== "true" && v !== "1" ? `${k}: ${v}` : k));
        }
        if (Array.isArray(value)) return value.map((item) => (typeof item === "object" && item !== null ? JSON.stringify(item) : String(item)));
        // JSON-строка опций из CRM — показываем как есть, без парсинга
        return value;
      }),
    agent_notes: optionalString,
    assigned_manager_id: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((value) => (value === undefined || value === null ? null : value)),
    assigned_manager_is_ai: optionalBool,
    is_active: optionalBool,
    rental_terms: rentalTermsSchema.nullish(),
  })
  .passthrough();

export type ListingDto = z.infer<typeof listingSchema>;

export const listingsResponseSchema = z
  .object({
    success: z.boolean().optional(),
    flats: z.array(listingSchema),
  })
  .passthrough();

export const contactResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    success: z.boolean().optional(),
    phone_number: z.string().optional(),
    contact_type: z.string().optional(),
  })
  .passthrough();

export const statusResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

export const dealResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    success: z.boolean().optional(),
  })
  .passthrough();

export const rentalTermsResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    success: z.boolean().optional(),
    listing_id: z.union([z.string(), z.number()]).optional(),
    changed_fields: z.array(z.string()).optional(),
  })
  .passthrough();

export const residentialComplexSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    name: z.string(),
  })
  .passthrough();

export const complexesResponseSchema = z
  .object({
    success: z.boolean().optional(),
    complexes: z.array(residentialComplexSchema).optional(),
  })
  .passthrough();

export const chatReplyResponseSchema = z
  .object({
    success: z.boolean().optional(),
    message_id: z.string().optional(),
    instance_id: z.string().optional(),
  })
  .passthrough();
