import { spawn, ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { createInterface } from "node:readline";
import { afterEach, describe, expect, it, vi } from "vitest";

const worker = vi.hoisted(() => ({ process: undefined as undefined | ((job: any) => Promise<void>) }));
vi.mock("bullmq", () => ({ Worker: class {
  constructor(_name: string, processor: (job: any) => Promise<void>) { worker.process = processor; }
  on() { return this; }
} }));

import { buildApp } from "../../src/app";
import { createHarness } from "../helpers/harness";
import { CrmInstanceRegistry } from "../../src/crm/instance-registry";
import { RealCrmClient } from "../../src/crm/crm.client";
import { CrmReplySender } from "../../src/crm/reply.sender";
import { createWebhookProxyWorker } from "../../src/crm/webhook-proxy";

const root = resolve(process.cwd(), "..");
const python = process.env.WAAPI_CRM_TEST_PYTHON ?? resolve(root, ".venv", process.platform === "win32" ? "Scripts/python.exe" : "bin/python");
const helper = resolve(root, "tests/waapi_crm_bridge.py");
const pn = "995555123456@c.us";
const phone = "+995555123456";

/** No listening ports: real Flask routes/SQLite are reached only through JSON stdin. */
class Bridge {
  child: ChildProcessWithoutNullStreams;
  dir = mkdtempSync(resolve(tmpdir(), "waapi-stage8-"));
  private callbacks: { resolve: (value: any) => void; reject: (error: Error) => void }[] = [];
  ready: Promise<any>;
  constructor() {
    this.child = spawn(python, ["-u", helper, this.dir], { cwd: root, env: { ...process.env, PYTHONIOENCODING: "utf-8" } });
    this.ready = new Promise((resolve, reject) => this.callbacks.push({ resolve, reject }));
    const fail = (error: Error) => { for (const callback of this.callbacks.splice(0)) callback.reject(error); };
    this.child.on("error", fail);
    this.child.on("exit", code => fail(Error(`Synthetic CRM bridge exited: ${code}`)));
    createInterface({ input: this.child.stdout }).on("line", line => {
      const callback = this.callbacks.shift();
      if (!callback) return;
      try { callback.resolve(JSON.parse(line)); } catch { callback.reject(Error("Invalid synthetic bridge response")); }
    });
    this.child.stderr.resume();
  }
  request(command: object): Promise<any> {
    return new Promise((resolve, reject) => {
      this.callbacks.push({ resolve: value => value.error ? reject(Error(value.error)) : resolve(value), reject });
      this.child.stdin.write(JSON.stringify(command) + "\n");
    });
  }
  async close() {
    if (this.child.exitCode === null && this.child.signalCode === null) {
      this.child.stdin.end();
      await new Promise<void>(resolve => this.child.once("exit", () => resolve()));
    }
    rmSync(this.dir, { recursive: true, force: true });
  }
}

function payload(type = "chat", id = "inbound", from = pn, event = "message", fromMe = false) {
  return { event, instanceId: "105907", data: { message: {
    id: { _serialized: id, fromMe }, fromMe, from, to: pn, type,
    body: type === "ptt" ? "" : "Можно сотрудничать?", timestamp: Math.floor(Date.now() / 1000),
  }, ...(type === "ptt" ? { media: { data: "T2dnUw==", mimetype: "audio/ogg; codecs=opus" } } : {}) } };
}

afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); worker.process = undefined; });

describe.skipIf(!existsSync(python) || !existsSync(helper))("WaAPI offline CRM + Batymi acceptance", () => {
  async function setup(echoBefore = false) {
    const bridge = new Bridge();
    expect(await bridge.ready).toEqual({ ready: true });
    const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only", CRM_BASE_URL: "https://crm.test/api", CRM_API_KEY: "stage8-key" });
    const jobs: any[] = [];
    let failReceipt = false;
    const fetcher = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.hostname !== "crm.test") throw Error("External network forbidden");
      if (failReceipt && url.pathname.includes("/waapi/webhook/")) {
        failReceipt = false;
        return new Response("{}", { status: 503 });
      }
      const response = await bridge.request({ path: url.pathname + url.search, method: init?.method ?? "GET",
        body: init?.body ? JSON.parse(String(init.body)) : undefined, headers: init?.headers, echoBefore });
      return new Response(JSON.stringify(response.body), { status: response.status });
    });
    vi.stubGlobal("fetch", fetcher);
    const registry = new CrmInstanceRegistry(h.config);
    await registry.refresh(true);
    h.services.instanceRegistry = registry;
    const realCrm = new RealCrmClient(h.config, h.services.logger);
    // Listing/model/transcription/Bull/Redis are synthetic; history, ingress, registry,
    // reply route, send ledger and Interaction storage are the real implementations.
    h.services.crm.getInteractions = realCrm.getInteractions.bind(realCrm);
    h.services.sender = new CrmReplySender(h.config, h.services.logger);
    h.crm.setContactState(phone, { status: "new" });
    h.llm.responder = () => JSON.stringify({ intent: "ask_cooperation", language: "ru" });
    const transcribe = vi.spyOn(h.services.transcription, "transcribe").mockResolvedValue("Можно сотрудничать?");
    h.services.webhookProxy = { handlesWaApiIngress: true, close: async () => {}, forward: async (instanceId, value) => {
      const job: any = { data: { instanceId, payload: value } };
      job.updateData = async (next: unknown) => { job.data = next; };
      jobs.push(job);
    } };
    createWebhookProxyWorker(h.config, h.services.logger, {} as never, h.services);
    const app = buildApp(h.services, { redisConnected: true, workerStarted: true });
    const post = (value: object) => app.inject({ method: "POST", url: "/webhooks/waapi/105907/stage8-secret", payload: value });
    const drain = async () => { while (jobs.length) await worker.process!(jobs.shift()); };
    return { bridge, h, post, drain, jobs, transcribe, fetcher, fail: () => { failReceipt = true; },
      close: async () => { await app.close(); await bridge.close(); } };
  }

  it.each(["chat", "ptt", "image"])("persists %s through both stacks, replies once, and attributes both echo orders", async type => {
    for (const before of [false, true]) {
      const s = await setup(before);
      try {
        if (type === "image") {
          s.h.config.ownerDialogueMode = "full";
          s.h.llm.responder = () => JSON.stringify({ reply: "Ответ на подпись", actions: [], stopConversation: false });
        }
        const inbound = payload(type, `false_777@lid_${type}_${before}_in`, "777@lid");
        // Provider LID lookup itself is mocked, with the same PN in both runtimes.
        const originalFetch = globalThis.fetch;
        vi.stubGlobal("fetch", async (input: any, init?: RequestInit) => String(input).includes("waapi.app")
          ? new Response(JSON.stringify({ status: "success", data: { status: "success", data: { contacts: [{ lid: "777@lid", pn }] } } }))
          : originalFetch(input, init));
        s.h.config.waapiApiToken = "stage8-token";
        expect((await s.post(inbound)).statusCode).toBe(200);
        expect(s.h.scheduler.jobs).toHaveLength(0);
        await s.drain();
        await s.post(inbound);
        await s.post({ ...inbound, event: "message_create" });
        await s.drain();
        await s.h.scheduler.runAll();
        expect(s.h.llm.calls).toHaveLength(1);
        expect(s.transcribe).toHaveBeenCalledTimes(type === "ptt" ? 1 : 0);
        await s.bridge.request({ op: "recover" });
        const state = await s.bridge.request({ op: "snapshot" });
        expect(state.messages).toHaveLength(2);
        expect(state.messages[0]).toMatchObject({ id: inbound.data.message.id._serialized, phone, instance: "105907", direction: "incoming" });
        expect(state.ledger).toHaveLength(1);
        expect(state.ledger[0]).toMatchObject({ sender: "agent", state: "accepted" });
        const sentId = state.ledger[0].id;
        expect(sentId).toMatch(/^true_opaque@lid_API_\d+_out$/);
        await s.post(payload("chat", sentId, pn, "message_create", true));
        const ack = payload("chat", sentId, pn, "message_ack", true);
        await s.post({ ...ack, data: { message: { ...ack.data.message, ack: 3 } } });
        await s.drain();
        const final = await s.bridge.request({ op: "snapshot" });
        expect(final.messages).toHaveLength(2);
        expect(final.messages[1]).toMatchObject({ sender: "agent", delivery: "read" });
        expect(final.status).toBe(state.status);
        expect(s.h.scheduler.jobs).toHaveLength(0);
      } finally { await s.close(); }
    }
  }, 60000);

  it("preserves cooperation_only caption policy while persisting image history", async () => {
    const s = await setup();
    try {
      await s.post(payload("image", "cooperation-image-caption"));
      await s.drain();
      await s.h.scheduler.runAll();
      const state = await s.bridge.request({ op: "snapshot" });
      expect(state.messages).toHaveLength(1);
      expect(state.messages[0].text).toBe("Можно сотрудничать?");
      expect(state.ledger).toHaveLength(0);
      expect(s.h.llm.calls).toHaveLength(0);
      expect(s.transcribe).not.toHaveBeenCalled();
    } finally { await s.close(); }
  });

  it("retries a CRM failure before buffering; manual phone reply pauses later audio/text without automation", async () => {
    const s = await setup();
    try {
      s.fail();
      await s.post(payload());
      await expect(worker.process!(s.jobs[0])).rejects.toThrow("HTTP 503");
      expect(s.h.scheduler.jobs).toHaveLength(0);
      expect((await s.bridge.request({ op: "snapshot" })).messages).toHaveLength(0);
      await s.drain();
      await s.post(payload("chat", "manual-full-id", pn, "message_create", true));
      await s.drain();
      await s.h.scheduler.runAll();
      expect(await s.h.store.getManualHandoff(`105907:${pn}`)).toBe("manager_takeover");
      const historyCalls = s.fetcher.mock.calls.filter(([url]) => String(url).includes("/interactions?")).length;
      await s.post(payload("ptt", "after-pause-audio"));
      await s.post(payload("chat", "after-pause-text"));
      await s.drain();
      await s.h.scheduler.runAll();
      expect(s.transcribe).not.toHaveBeenCalled();
      expect(s.h.llm.calls).toHaveLength(0);
      expect(s.h.debug.snapshot().crmActions).toHaveLength(0);
      expect(s.fetcher.mock.calls.filter(([url]) => String(url).includes("/interactions?")).length).toBe(historyCalls);
      const state = await s.bridge.request({ op: "snapshot" });
      expect(state.ledger).toHaveLength(0);
      expect(state.messages).toHaveLength(4); // Receipt/history remain durable during pause.
      expect(state.messages.find((m: any) => m.id === "manual-full-id").sender).toBe("phone");
    } finally { await s.close(); }
  }, 30000);
});
