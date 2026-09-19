import { Config } from "./config/env";
import { ConversationStore } from "./buffer/conversation-store";
import { ConversationScheduler } from "./queue/conversation.queue";
import { CrmClient } from "./crm/crm.client";
import { GreenApiClient } from "./greenapi/greenapi.client";
import { LlmProvider } from "./agent/llm.provider";
import { TranscriptionService } from "./transcription/transcription.service";
import { Logger } from "./observability/logger";
import { DebugRecorder } from "./observability/debug-recorder";

export interface Services {
  config: Config;
  logger: Logger;
  store: ConversationStore;
  scheduler: ConversationScheduler;
  crm: CrmClient;
  greenApi: GreenApiClient;
  llm: LlmProvider;
  transcription: TranscriptionService;
  debug: DebugRecorder;
}
