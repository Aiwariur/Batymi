import { z } from "zod";
import { ContactType, CrmStatus, DealInfo } from "../types";

const normalizedString = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["owner", "realtor", "potential_owner"]),
);

export const contactTypeSchema = normalizedString as unknown as z.ZodType<ContactType>;

export const crmStatusSchema = z.preprocess(
  (value) => (typeof value === "string" ? value.trim().toLowerCase() : value),
  z.enum(["agreed", "qualified", "disagreed"]),
) as unknown as z.ZodType<CrmStatus>;

export const dealInfoSchema = z.object({
  commission_type: z.string().default(""),
  commission_value: z.string().default(""),
  price_net: z.string().default(""),
  window_view: z.string().default(""),
  complex_name: z.string().default(""),
  cadastral_code: z.string().default(""),
  agent_notes: z.string().default(""),
});

export const setContactTypeActionSchema = z.object({
  type: z.literal("set_contact_type"),
  contactType: contactTypeSchema,
});

export const updateDealInfoActionSchema = z.object({
  type: z.literal("update_deal_info"),
  data: dealInfoSchema,
});

export const setCrmStatusActionSchema = z.object({
  type: z.literal("set_crm_status"),
  status: crmStatusSchema,
  flatId: z.union([z.string(), z.number()]).optional(),
});

export const actionSchema = z.discriminatedUnion("type", [
  setContactTypeActionSchema,
  updateDealInfoActionSchema,
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
export type SetCrmStatusAction = z.infer<typeof setCrmStatusActionSchema>;

export function emptyDealInfo(): DealInfo {
  return {
    commission_type: "",
    commission_value: "",
    price_net: "",
    window_view: "",
    complex_name: "",
    cadastral_code: "",
    agent_notes: "",
  };
}
