import { z } from "zod";

const messageDataSchema = z
  .object({
    typeMessage: z.string(),
    textMessageData: z
      .object({
        textMessage: z.string().optional(),
      })
      .partial()
      .optional(),
    fileMessageData: z
      .object({
        downloadUrl: z.string().optional(),
        caption: z.string().optional(),
        fileName: z.string().optional(),
        mimeType: z.string().optional(),
      })
      .partial()
      .optional(),
    extendedTextMessageData: z
      .object({
        text: z.string().optional(),
      })
      .partial()
      .optional(),
  })
  .passthrough();

export const greenApiWebhookSchema = z
  .object({
    typeWebhook: z.string(),
    idMessage: z.string().optional(),
    timestamp: z.number().optional(),
    instanceData: z
      .object({
        idInstance: z.union([z.number(), z.string()]).optional(),
        wid: z.string().optional(),
        typeInstance: z.string().optional(),
      })
      .passthrough()
      .optional(),
    senderData: z
      .object({
        chatId: z.string(),
        chatName: z.string().optional(),
        sender: z.string().optional(),
        senderName: z.string().optional(),
      })
      .passthrough()
      .optional(),
    messageData: messageDataSchema.optional(),
  })
  .passthrough();

export type GreenApiWebhookPayload = z.infer<typeof greenApiWebhookSchema>;
