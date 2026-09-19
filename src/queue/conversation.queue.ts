import { createHash } from "crypto";
import { Queue } from "bullmq";
import type IORedis from "ioredis";

export interface ConversationJobData {
  conversationKey: string;
  token: string;
  retryCount?: number;
}

export interface ConversationScheduler {
  schedule(conversationKey: string, token: string, delayMs: number, retryCount?: number): Promise<void>;
  close(): Promise<void>;
}

export function jobIdFor(conversationKey: string, token: string): string {
  const hash = createHash("sha1").update(conversationKey).digest("hex").slice(0, 20);
  return `conv_${hash}_${token}`;
}

export class BullConversationScheduler implements ConversationScheduler {
  private readonly queue: Queue<ConversationJobData>;

  constructor(connection: IORedis, queueName: string) {
    this.queue = new Queue<ConversationJobData>(queueName, {
      connection,
      defaultJobOptions: {
        attempts: 3,
        backoff: { type: "exponential", delay: 1000 },
        removeOnComplete: true,
        removeOnFail: 1000,
      },
    });
  }

  async schedule(
    conversationKey: string,
    token: string,
    delayMs: number,
    retryCount = 0,
  ): Promise<void> {
    await this.queue.add(
      "process",
      { conversationKey, token, retryCount },
      {
        delay: Math.max(0, Math.round(delayMs)),
        jobId: jobIdFor(conversationKey, token),
      },
    );
  }

  async close(): Promise<void> {
    await this.queue.close();
  }
}
