import { z } from "zod";

const messageSchema = z.object({
  id: z.object({ _serialized: z.string().min(1).refine(v => !!v.trim()), fromMe: z.boolean().optional(), remote: z.string().optional() }).passthrough(),
  fromMe: z.boolean(), from: z.string(), to: z.string().optional(),
  // Media without a caption may carry null instead of omitting the text field.
  type: z.string(), body: z.string().nullish().transform(value => value ?? undefined), timestamp: z.number().finite().nonnegative(),
  ack: z.number().int().min(-1).max(4).optional(), hasMedia: z.boolean().optional(),
  isStatus: z.boolean().optional(), isGroupMsg: z.boolean().optional(),
}).passthrough().refine(m => m.id.fromMe === undefined || m.id.fromMe === m.fromMe, "inconsistent origin");

export const waApiWebhookSchema = z.object({
  event: z.string().min(1), instanceId: z.union([z.string().min(1), z.number().int().positive()]).transform(String),
  data: z.object({
    message: messageSchema.optional(),
    media: z.object({ data: z.string().optional(), mimetype: z.string(), filename: z.string().optional(), filesize: z.number().optional() }).passthrough().nullable().optional(),
  }).passthrough(),
}).passthrough().superRefine((p, ctx) => {
  if (["message", "message_create", "message_ack"].includes(p.event) && !p.data.message)
    ctx.addIssue({ code: "custom", message: "message required" });
  if (p.event === "message_ack" && p.data.message?.ack === undefined)
    ctx.addIssue({ code: "custom", message: "ack required" });
});
export type WaApiWebhookPayload = z.infer<typeof waApiWebhookSchema>;
