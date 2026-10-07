import { createCipheriv, createHash, randomBytes } from "crypto";
import { promises as fs } from "fs";
import path from "path";

interface EncryptedTraceRecord {
  v: 1;
  iv: string;
  tag: string;
  ciphertext: string;
}

export interface RunTrace {
  readonly enabled: boolean;
  record(runId: string, event: string, payload: unknown): Promise<void>;
}

interface RunTraceOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  warn?: (message: string) => void;
}

function parseKey(raw: string | undefined): Buffer | null {
  if (!raw) return null;
  const value = raw.trim();
  if (/^[0-9a-fA-F]{64}$/.test(value)) return Buffer.from(value, "hex");

  // Also accept a base64/base64url encoded 32-byte key.
  const decoded = Buffer.from(value, "base64url");
  if (decoded.length === 32 && decoded.toString("base64url") === value.replace(/=+$/, "")) {
    return decoded;
  }
  return null;
}

function safeRetentionDays(raw: string | undefined): number {
  if (!raw) return 7;
  const parsed = Number(raw);
  return Number.isInteger(parsed) && parsed >= 1 && parsed <= 3650 ? parsed : 7;
}

/**
 * AES-256-GCM encrypted run trace. RUN_TRACE_KEY accepts 64 hex characters
 * or a base64url encoded 32-byte key. Each record is a separate authenticated
 * ciphertext file; run IDs, event names, and payloads stay inside encryption.
 *
 * The directory is created with owner-only POSIX permissions and files with
 * owner read/write permissions. Windows chmod does not replace NTFS ACLs:
 * deployments on Windows must restrict inherited directory ACLs as well.
 */
export function createRunTrace(options: RunTraceOptions = {}): RunTrace {
  const env = options.env ?? process.env;
  const key = parseKey(env.RUN_TRACE_KEY);
  const dir = path.resolve(env.RUN_TRACE_DIR || path.join(process.cwd(), "data", "run-traces"));
  const retentionMs = safeRetentionDays(env.RUN_TRACE_RETENTION_DAYS) * 24 * 60 * 60 * 1000;
  const now = options.now ?? (() => new Date());
  const warn = options.warn ?? ((message: string) => console.warn(message));

  if (!key) {
    warn(
      env.RUN_TRACE_KEY
        ? "Run trace disabled: RUN_TRACE_KEY must be a 32-byte key encoded as 64 hex or base64url characters."
        : "Run trace disabled: RUN_TRACE_KEY is not configured; no durable run trace will be recorded.",
    );
  }

  async function pruneExpired(currentTime: number): Promise<void> {
    const names = await fs.readdir(dir);
    await Promise.all(
      names
        .filter((name) => name.endsWith(".trace"))
        .map(async (name) => {
          const filename = path.join(dir, name);
          const stat = await fs.stat(filename);
          if (stat.isFile() && currentTime - stat.mtimeMs > retentionMs) {
            await fs.unlink(filename);
          }
        }),
    );
  }

  return {
    get enabled() {
      return key !== null;
    },

    async record(runId: string, event: string, payload: unknown): Promise<void> {
      if (!key) return;
      try {
        const timestamp = now();
        const plaintext = JSON.stringify({ recordedAt: timestamp.toISOString(), runId, event, payload });
        if (typeof plaintext !== "string") throw new Error("trace record is not JSON serializable");

        const iv = randomBytes(12);
        const cipher = createCipheriv("aes-256-gcm", key, iv);
        const ciphertext = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
        const envelope: EncryptedTraceRecord = {
          v: 1,
          iv: iv.toString("base64url"),
          tag: cipher.getAuthTag().toString("base64url"),
          ciphertext: ciphertext.toString("base64url"),
        };

        await fs.mkdir(dir, { recursive: true, mode: 0o700 });
        await fs.chmod(dir, 0o700);
        const runHash = createHash("sha256").update(runId).digest("hex");
        const recordName = `${runHash}.${timestamp.getTime()}.${randomBytes(6).toString("hex")}.trace`;
        const handle = await fs.open(path.join(dir, recordName), "wx", 0o600);
        try {
          await handle.writeFile(`${JSON.stringify(envelope)}\n`, { encoding: "utf8" });
          await handle.sync();
          await handle.chmod(0o600);
        } finally {
          await handle.close();
        }
        await pruneExpired(timestamp.getTime());
      } catch (error) {
        const detail = error instanceof Error ? error.message : String(error);
        warn(`Run trace write failed; conversation processing will continue without this trace record: ${detail}`);
      }
    },
  };
}

export const runTrace = createRunTrace();
