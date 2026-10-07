import { createDecipheriv } from "crypto";
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { afterEach, describe, expect, it } from "vitest";
import { createRunTrace } from "../../src/observability/run-trace";

const key = Buffer.alloc(32, 7);
const keyHex = key.toString("hex");
const temporaryDirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "batymi-run-trace-"));
  temporaryDirs.push(dir);
  return dir;
}

afterEach(async () => {
  await Promise.all(temporaryDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe("encrypted run trace", () => {
  it("stores authenticated ciphertext and can decrypt the record with its key", async () => {
    const dir = await makeTempDir();
    const trace = createRunTrace({ env: { RUN_TRACE_KEY: keyHex, RUN_TRACE_DIR: dir } });
    const privateText = "owner phone 995555000000 and quoted message";

    await trace.record("run-sensitive-id", "model.input", { text: privateText });

    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".trace"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toContain("run-sensitive-id");
    const raw = await fs.readFile(path.join(dir, files[0]), "utf8");
    expect(raw).not.toContain(privateText);
    expect(raw).not.toContain("995555000000");

    const envelope = JSON.parse(raw) as { v: number; iv: string; tag: string; ciphertext: string };
    expect(envelope.v).toBe(1);
    const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(envelope.iv, "base64url"));
    decipher.setAuthTag(Buffer.from(envelope.tag, "base64url"));
    const plaintext = Buffer.concat([
      decipher.update(Buffer.from(envelope.ciphertext, "base64url")),
      decipher.final(),
    ]).toString("utf8");
    expect(JSON.parse(plaintext)).toMatchObject({
      runId: "run-sensitive-id",
      event: "model.input",
      payload: { text: privateText },
    });
  });

  it("warns and disables recording when the key is absent", async () => {
    const dir = await makeTempDir();
    const warnings: string[] = [];
    const trace = createRunTrace({
      env: { RUN_TRACE_DIR: dir },
      warn: (message) => warnings.push(message),
    });

    await trace.record("run-1", "event", { text: "private" });

    expect(trace.enabled).toBe(false);
    expect(warnings.join(" ")).toMatch(/RUN_TRACE_KEY is not configured/);
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it("removes expired trace files according to the configured retention", async () => {
    const dir = await makeTempDir();
    const trace = createRunTrace({
      env: { RUN_TRACE_KEY: keyHex, RUN_TRACE_DIR: dir, RUN_TRACE_RETENTION_DAYS: "1" },
    });
    await trace.record("old-run", "event", {});
    const first = (await fs.readdir(dir)).find((name) => name.endsWith(".trace"))!;
    const oldDate = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000);
    await fs.utimes(path.join(dir, first), oldDate, oldDate);

    await trace.record("new-run", "event", {});

    const files = (await fs.readdir(dir)).filter((name) => name.endsWith(".trace"));
    expect(files).toHaveLength(1);
    expect(files[0]).not.toBe(first);
  });
});
