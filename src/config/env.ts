import "dotenv/config";
import { z } from "zod";
import { InstanceConfig, parseInstances } from "./instances";

const boolFromString = (defaultValue: boolean) =>
  z
    .preprocess((value) => {
      if (value === undefined || value === null || value === "") return defaultValue;
      if (typeof value === "boolean") return value;
      return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
    }, z.boolean())
    .default(defaultValue);

const boolOptional = () =>
  z.preprocess((value) => {
    if (value === undefined || value === null || value === "") return undefined;
    if (typeof value === "boolean") return value;
    return ["1", "true", "yes", "on"].includes(String(value).toLowerCase());
  }, z.boolean().optional());

const envSchema = z.object({
  NODE_ENV: z.enum(["development", "test", "production"]).default("development"),
  HOST: z.string().default("0.0.0.0"),
  PORT: z.coerce.number().int().positive().default(3000),

  REDIS_URL: z.string().default("redis://localhost:6379"),

  MESSAGE_DEBOUNCE_MS: z.coerce.number().int().nonnegative().default(10000),
  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(20),
  CONVERSATION_HISTORY_MAX_MESSAGES: z.coerce.number().int().positive().default(30),
  CONVERSATION_HISTORY_TTL_DAYS: z.coerce.number().positive().default(30),
  CONVERSATION_LOCK_TTL_MS: z.coerce.number().int().positive().default(120000),
  IDEMPOTENCY_TTL_SECONDS: z.coerce.number().int().positive().default(86400),

  CRM_BASE_URL: z.string().default(""),
  CRM_API_KEY: z.string().default(""),

  LLM_PROVIDER: z.string().default("openai"),
  LLM_MODEL: z.string().default("gpt-4.1"),
  LLM_API_KEY: z.string().default(""),
  LLM_BASE_URL: z.string().default("https://api.openai.com/v1"),
  LLM_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_TEMPERATURE: z.coerce.number().min(0).max(2).default(0.5),
  LLM_FREQUENCY_PENALTY: z.coerce.number().min(0).max(2).default(0.5),
  LLM_TOP_P: z.coerce.number().min(0).max(1).default(0.9),
  TRANSCRIPTION_MODEL: z.string().default("whisper-1"),

  // Фильтр «только контакты, назначенные на наших менеджеров»:
  // SENT_AUTO_MANAGER_ID=2 в арендной CRM — broadcast назначает менеджера 2.
  ALLOWED_MANAGER_IDS: z.string().default("2"),
  // Статусы, в которых движок не отвечает и не зовёт LLM.
  TERMINAL_CRM_STATUSES: z.string().default("disagreed,archived,no_whatsapp"),

  MOCK_EXTERNALS: boolFromString(true),
  MOCK_CRM: boolOptional(),
  MOCK_LLM: boolOptional(),
  MOCK_GREENAPI: boolOptional(),
  MOCK_TRANSCRIPTION: boolOptional(),

  API_ENABLED: boolFromString(true),
  WORKER_ENABLED: boolFromString(true),
  QUEUE_NAME: z.string().default("conversation"),

  LOG_LEVEL: z.string().default("info"),
  LOG_MESSAGE_CONTENT: boolFromString(false),
});

export interface Config {
  nodeEnv: "development" | "test" | "production";
  isProduction: boolean;
  host: string;
  port: number;

  redisUrl: string;

  messageDebounceMs: number;
  workerConcurrency: number;
  conversationHistoryMaxMessages: number;
  conversationHistoryTtlSeconds: number;
  conversationLockTtlMs: number;
  idempotencyTtlSeconds: number;

  crmBaseUrl: string;
  crmApiKey: string;

  llmProvider: string;
  llmModel: string;
  llmApiKey: string;
  llmBaseUrl: string;
  llmMaxTokens: number;
  llmTemperature: number;
  llmFrequencyPenalty: number;
  llmTopP: number;
  transcriptionModel: string;

  instances: InstanceConfig[];

  allowedManagerIds: number[];
  terminalCrmStatuses: string[];

  mockExternals: boolean;
  mockCrm: boolean;
  mockLlm: boolean;
  mockGreenApi: boolean;
  mockTranscription: boolean;

  apiEnabled: boolean;
  workerEnabled: boolean;
  queueName: string;

  logLevel: string;
  logMessageContent: boolean;
}

function parseCsvNumbers(value: string): number[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => Number(part))
    .filter((n) => Number.isFinite(n));
}

function parseCsv(value: string): string[] {
  return value
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = envSchema.safeParse(env);
  if (!parsed.success) {
    const details = parsed.error.issues
      .map((issue) => `${issue.path.join(".")}: ${issue.message}`)
      .join("; ");
    throw new Error(`Invalid environment configuration: ${details}`);
  }
  const e = parsed.data;

  const mockCrm = e.MOCK_CRM ?? e.MOCK_EXTERNALS;
  const mockLlm = e.MOCK_LLM ?? e.MOCK_EXTERNALS;
  const mockGreenApi = e.MOCK_GREENAPI ?? e.MOCK_EXTERNALS;
  const mockTranscription = e.MOCK_TRANSCRIPTION ?? e.MOCK_EXTERNALS;

  const instances = parseInstances(env, e.MOCK_EXTERNALS);

  return {
    nodeEnv: e.NODE_ENV,
    isProduction: e.NODE_ENV === "production",
    host: e.HOST,
    port: e.PORT,

    redisUrl: e.REDIS_URL,

    messageDebounceMs: e.MESSAGE_DEBOUNCE_MS,
    workerConcurrency: e.WORKER_CONCURRENCY,
    conversationHistoryMaxMessages: e.CONVERSATION_HISTORY_MAX_MESSAGES,
    conversationHistoryTtlSeconds: Math.round(e.CONVERSATION_HISTORY_TTL_DAYS * 86400),
    conversationLockTtlMs: e.CONVERSATION_LOCK_TTL_MS,
    idempotencyTtlSeconds: e.IDEMPOTENCY_TTL_SECONDS,

    crmBaseUrl: e.CRM_BASE_URL.replace(/\/+$/, ""),
    crmApiKey: e.CRM_API_KEY,

    llmProvider: e.LLM_PROVIDER,
    llmModel: e.LLM_MODEL,
    llmApiKey: e.LLM_API_KEY,
    llmBaseUrl: e.LLM_BASE_URL.replace(/\/+$/, ""),
    llmMaxTokens: e.LLM_MAX_TOKENS,
    llmTemperature: e.LLM_TEMPERATURE,
    llmFrequencyPenalty: e.LLM_FREQUENCY_PENALTY,
    llmTopP: e.LLM_TOP_P,
    transcriptionModel: e.TRANSCRIPTION_MODEL,

    instances,

    allowedManagerIds: parseCsvNumbers(e.ALLOWED_MANAGER_IDS),
    terminalCrmStatuses: parseCsv(e.TERMINAL_CRM_STATUSES).map((s) => s.toLowerCase()),

    mockExternals: e.MOCK_EXTERNALS,
    mockCrm,
    mockLlm,
    mockGreenApi,
    mockTranscription,

    apiEnabled: e.API_ENABLED,
    workerEnabled: e.WORKER_ENABLED,
    queueName: e.QUEUE_NAME,

    logLevel: e.LOG_LEVEL,
    logMessageContent: e.LOG_MESSAGE_CONTENT,
  };
}
