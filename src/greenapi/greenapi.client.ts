import { Config } from "../config/env";
import { InstanceConfig } from "../config/instances";
import { Logger } from "../observability/logger";
import { DebugRecorder } from "../observability/debug-recorder";
import { OutgoingMessage } from "../types";

export interface SendMessageInput {
  instanceId: string;
  chatId: string;
  message: string;
}

export interface SendMessageResult {
  idMessage?: string;
  mocked: boolean;
}

export interface GreenApiClient {
  sendMessage(input: SendMessageInput): Promise<SendMessageResult>;
}

export class RealGreenApiClient implements GreenApiClient {
  constructor(
    private readonly config: Config,
    private readonly logger: Logger,
  ) {}

  private instanceOrThrow(instanceId: string): InstanceConfig {
    const instance = this.config.instances.find((i) => i.id === instanceId);
    if (!instance) throw new Error(`Unknown GreenAPI instance: ${instanceId}`);
    return instance;
  }

  async sendMessage(input: SendMessageInput): Promise<SendMessageResult> {
    const instance = this.instanceOrThrow(input.instanceId);
    const url = `${this.config.greenApiUrl}/waInstance${instance.id}/sendMessage/${instance.token}`;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chatId: input.chatId, message: input.message }),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => "");
      throw new Error(`GreenAPI sendMessage failed: HTTP ${response.status} ${body.slice(0, 300)}`);
    }

    const data = (await response.json().catch(() => ({}))) as { idMessage?: string };
    this.logger.debug({ instanceId: input.instanceId }, "greenapi.sendMessage.ok");
    return { idMessage: data.idMessage, mocked: false };
  }
}

export class MockGreenApiClient implements GreenApiClient {
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
      "greenapi.sendMessage.mocked",
    );
    return { idMessage: `mock-${Date.now()}`, mocked: true };
  }
}

export function createGreenApiClient(
  config: Config,
  logger: Logger,
  debug: DebugRecorder,
): GreenApiClient {
  return config.mockGreenApi
    ? new MockGreenApiClient(debug, logger)
    : new RealGreenApiClient(config, logger);
}
