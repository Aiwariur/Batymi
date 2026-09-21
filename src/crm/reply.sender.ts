import { Config } from "../config/env";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { OutgoingMessage } from "../types";
import { chatReplyResponseSchema } from "./crm.schemas";

const REQUEST_TIMEOUT_MS = 20000;

export interface SendMessageInput {
  instanceId: string;
  chatId: string;
  message: string;
}

export interface SendMessageResult {
  idMessage?: string;
  mocked: boolean;
}

/**
 * Отправка ответов собственникам всегда идёт через CRM /api/chat/reply:
 * CRM выбирает инстанс по правилу «отвечать с того же номера» и пишет
 * исходящее в interactions, поэтому диалоги/воронка в CRM остаются полными.
 */
export interface MessageSender {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}

/** "9955XXXXXXXXX@c.us" → "+9955XXXXXXXXX". */
export function chatIdToPhone(chatId: string): string {
  const digits = chatId.split("@")[0].replace(/[^\d]/g, "");
  return `+${digits}`;
}

export class CrmReplySender implements MessageSender {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    if (!this.config.crmBaseUrl) {
      throw new Error("CRM_BASE_URL is not configured");
    }
    if (!this.config.crmApiKey) {
      throw new Error("CRM_API_KEY is not configured");
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
    try {
      const response = await fetch(`${this.config.crmBaseUrl}/chat/reply`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-API-Key": this.config.crmApiKey,
        },
        body: JSON.stringify({
          phone: chatIdToPhone(input.chatId),
          message: input.message,
          instance_id: input.instanceId,
        }),
        signal: controller.signal,
      });

      if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(
          `CRM /chat/reply failed: HTTP ${response.status} ${body.slice(0, 300)}`,
        );
      }

      const json = (await response.json().catch(() => ({}))) as unknown;
      const parsed = chatReplyResponseSchema.safeParse(json);
      if (!parsed.success) {
        throw new Error("CRM /chat/reply response failed validation");
      }
      this.logger.debug({ instanceId: input.instanceId }, "crm.reply.sent");
      return { idMessage: parsed.data.message_id, mocked: false };
    } finally {
      clearTimeout(timer);
    }
  }
}

export class MockMessageSender implements MessageSender {
  constructor(
    private readonly debug: DebugRecorder,
    private readonly logger: Logger,
  ) {}

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const outgoing: OutgoingMessage = {
      instanceId: input.instanceId,
      chatId: input.chatId,
      message: input.message,
      ts: Date.now(),
      mocked: true,
    };
    this.debug.recordOutgoing(outgoing);
    this.logger.debug(
      { instanceId: input.instanceId, chatId: input.chatId },
      "crm.reply.mocked",
    );
    return { idMessage: `mock-${Date.now()}`, mocked: true };
  }
}

export function createMessageSender(
  config: Config,
  logger: Logger,
  debug: DebugRecorder,
): MessageSender {
  return config.mockCrm
    ? new MockMessageSender(debug, logger)
    : new CrmReplySender(config, logger);
}
