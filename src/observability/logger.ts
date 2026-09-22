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
        "req.headers.authorization",
        "headers.authorization",
        "req.headers['x-greenapi-webhook-secret']",
        "headers['x-greenapi-webhook-secret']",
        // The secret header name is configurable, so redact all request
        // headers in structured request logs rather than relying on a fixed
        // spelling.
        "req.headers.*",
        "headers.*",
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
