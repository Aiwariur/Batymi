import { Worker } from "bullmq";
import type IORedis from "ioredis";
import { Services } from "../services";
import { handleConversationJob } from "../conversation/conversation.service";
import { ConversationJobData } from "./conversation.queue";

export function createConversationWorker(
  services: Services,
  connection: IORedis,
): Worker<ConversationJobData> {
  const worker = new Worker<ConversationJobData>(
    services.config.queueName,
    async (job) => {
      return handleConversationJob(
        {
          conversationKey: job.data.conversationKey,
          token: job.data.token,
          retryCount: job.data.retryCount ?? 0,
        },
        {
          attemptsMade: job.attemptsMade,
          maxAttempts: job.opts.attempts ?? 1,
          jobId: String(job.id),
        },
        services,
      );
    },
    {
      connection,
      concurrency: services.config.workerConcurrency,
    },
  );

  worker.on("failed", (job, error) => {
    services.logger.error(
      { jobId: job?.id, conversationKey: job?.data?.conversationKey, err: error.message },
      "worker.job.failed",
    );
  });

  worker.on("error", (error) => {
    services.logger.error({ err: error.message }, "worker.error");
  });

  return worker;
}
