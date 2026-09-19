import pino, { Logger } from "pino";

export type { Logger };

export interface LoggerOptions {
  level: string;
  pretty: boolean;
}

function hasPinoPretty(): boolean {
  try {
    require.resolve("pino-pretty");
    return true;
  } catch {
    return false;
  }
}

export function createLogger(options: LoggerOptions): Logger {
  const usePretty = options.pretty && hasPinoPretty();
  return pino({
    level: options.level,
    base: undefined,
    redact: {
      paths: [
        "*.token",
        "*.apiKey",
        "*.api_key",
        "token",
        "apiKey",
        "req.headers['x-api-key']",
        "headers['x-api-key']",
      ],
      censor: "[redacted]",
    },
    transport: usePretty
      ? {
          target: "pino-pretty",
          options: {
            colorize: true,
            translateTime: "SYS:HH:MM:ss.l",
            ignore: "pid,hostname",
          },
        }
      : undefined,
  });
}
