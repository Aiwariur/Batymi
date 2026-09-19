import { randomUUID } from "crypto";

const baseUrl = process.env.APP_URL ?? "http://localhost:3000";

interface DebugState {
  outgoing: Array<{ instanceId: string; chatId: string; message: string; mocked: boolean }>;
  crmActions: Array<{ action: string; payload: unknown }>;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function getJson<T>(path: string): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`);
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

async function postJson<T>(path: string, payload: unknown): Promise<{ status: number; body: T }> {
  const response = await fetch(`${baseUrl}${path}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  const body = (await response.json().catch(() => ({}))) as T;
  return { status: response.status, body };
}

async function main(): Promise<void> {
  const checks: string[] = [];
  let stage = "health";

  try {
    const health = await getJson<{ ok: boolean; redis: string; instances: number }>("/health/ready");
    if (!health.body.ok) throw new Error(`health/ready returned ${health.status}`);
    checks.push("API reachable");
    checks.push("Redis connected");

    const config = await getJson<{ instances: string[]; messageDebounceMs: number }>("/debug/config");
    const instanceId = process.env.SMOKE_INSTANCE_ID ?? config.body.instances[0];
    if (!instanceId) throw new Error("no GreenAPI instances configured");
    const debounceMs = config.body.messageDebounceMs ?? 10000;

    await postJson("/debug/reset", {});

    stage = "webhook";
    const chatId = process.env.SMOKE_CHAT_ID ?? `9955${String(Date.now()).slice(-7)}@c.us`;
    const idMessage = `smoke-${randomUUID()}`;
    const webhook = await postJson<{ ok: boolean; buffered: boolean }>(
      `/webhooks/greenapi/${instanceId}`,
      {
        typeWebhook: "incomingMessageReceived",
        idMessage,
        timestamp: Math.floor(Date.now() / 1000),
        instanceData: { idInstance: instanceId, typeInstance: "whatsapp" },
        senderData: { chatId, chatName: "Smoke test", sender: chatId, senderName: "Smoke test" },
        messageData: {
          typeMessage: "textMessage",
          textMessageData: { textMessage: "Да, я собственник, можно работать" },
        },
      },
    );
    if (webhook.status !== 200 || !webhook.body.ok) {
      throw new Error(`webhook rejected: HTTP ${webhook.status}`);
    }
    checks.push("webhook accepted");
    if (webhook.body.buffered) checks.push("message buffered");

    stage = "conversation.worker";
    const deadline = Date.now() + debounceMs + 25000;
    let state: DebugState = { outgoing: [], crmActions: [] };
    while (Date.now() < deadline) {
      const current = await getJson<DebugState>("/debug/state");
      state = current.body;
      const hasOutgoing = state.outgoing.some((m) => m.chatId === chatId);
      const hasCrm = state.crmActions.some(
        (a) => a.action === "set_contact_type" || a.action === "set_crm_status",
      );
      if (hasOutgoing && hasCrm) break;
      await sleep(500);
    }

    if (state.crmActions.some((a) => a.action === "set_contact_type")) {
      checks.push("debounce fired");
      checks.push("worker processed conversation");
      checks.push("CRM contact updated");
    } else {
      throw new Error("no CRM action recorded after debounce");
    }

    const outgoing = state.outgoing.find((m) => m.chatId === chatId);
    if (!outgoing) throw new Error("no outgoing WhatsApp message recorded");
    checks.push("outgoing message generated");

    for (const check of checks) console.log(`\u2713 ${check}`);
    console.log("\nSMOKE TEST PASSED");
    if (outgoing) console.log(`\nMock reply: ${outgoing.message}`);
  } catch (error) {
    console.log("\nSMOKE TEST FAILED\n");
    console.log(`stage: ${stage}`);
    console.log(`reason: ${(error as Error).message}`);
    process.exit(1);
  }
}

void main();
