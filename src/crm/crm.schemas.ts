import { z } from "zod";

const optionalString = z
  .union([z.string(), z.number(), z.null()])
  .optional()
  .transform((value) => (value === undefined || value === null ? null : String(value)));

export const flatSchema = z
  .object({
    id: z.union([z.string(), z.number()]),
    crm_status: optionalString,
    phone: optionalString,
    contact_name: optionalString,
    contact_type: optionalString,
    address: optionalString,
    district: optionalString,
    rooms: optionalString,
    area: optionalString,
    floor: optionalString,
    price: optionalString,
    currency: optionalString,
    url: optionalString,
    commission_type: optionalString,
    commission_value: optionalString,
    price_net: optionalString,
    window_view: optionalString,
    complex_name: optionalString,
    cadastral_code: optionalString,
    agent_notes: optionalString,
    assigned_manager_id: z
      .union([z.string(), z.number(), z.null()])
      .optional()
      .transform((value) => (value === undefined || value === null ? null : value)),
  })
  .passthrough();

export type FlatDto = z.infer<typeof flatSchema>;

export const flatsResponseSchema = z
  .object({
    flats: z.array(flatSchema),
  })
  .passthrough();

export const contactResponseSchema = z
  .object({
    ok: z.boolean().optional(),
    phone_number: z.string().optional(),
    contact_type: z.string().optional(),
  })
  .passthrough();

export const statusResponseSchema = z
  .object({
    ok: z.boolean().optional(),
  })
  .passthrough();

export const dealResponseSchema = z
  .object({
    ok: z.boolean().optional(),
  })
  .passthrough();
