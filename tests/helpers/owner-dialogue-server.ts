import { createServer, IncomingMessage, Server, ServerResponse } from "node:http";
import { AddressInfo } from "node:net";
import { Listing } from "../../src/types";

export interface TestInteraction {
  id: string;
  text: string;
  sender: "owner" | "manager" | "agent";
  direction: "inbound" | "outbound";
  sent_at: string;
  whatsapp_message_id?: string;
  whatsapp_instance_id?: string;
  message_id?: string;
  instance_id?: string;
  channel?: string;
}

export interface TestContactState {
  phone: string;
  contact_type: string | null;
  listings: Listing[];
  interactions: TestInteraction[];
}

export interface CrmWrite {
  method: string;
  path: string;
  body: unknown;
  before: unknown;
  after: unknown;
  statusCode: number;
}

function sendJson(response: ServerResponse, status: number, value: unknown): void {
  response.writeHead(status, { "Content-Type": "application/json" });
  response.end(JSON.stringify(value));
}

async function readJson(request: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const chunk of request) chunks.push(Buffer.from(chunk));
  if (!chunks.length) return {};
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
}

/** In-process HTTP CRM implementing only the production endpoints used by acceptance runs. */
export class OwnerDialogueTestCrm {
  private server?: Server;
  private nextInteraction = 1;
  readonly writes: CrmWrite[] = [];
  readonly sentMessages: Array<{ phone: string; instance_id: string; message: string; message_id: string }> = [];
  failNextWrite = false;
  baseUrl = "";

  constructor(readonly state: TestContactState, readonly apiKey = "owner-dialogue-test-key") {}

  async start(): Promise<void> {
    this.server = createServer((request, response) => void this.route(request, response));
    await new Promise<void>((resolve, reject) => {
      this.server!.once("error", reject);
      this.server!.listen(0, "127.0.0.1", resolve);
    });
    this.baseUrl = `http://127.0.0.1:${(this.server!.address() as AddressInfo).port}/api`;
  }

  async close(): Promise<void> {
    if (!this.server) return;
    await new Promise<void>((resolve, reject) => this.server!.close((error) => error ? reject(error) : resolve()));
    this.server = undefined;
  }

  addOwnerMessage(text: string, id: string, instanceId: string, sentAt = new Date().toISOString()): void {
    this.state.interactions.push({
      id, text, sender: "owner", direction: "inbound", sent_at: sentAt,
      whatsapp_message_id: id, whatsapp_instance_id: instanceId,
    });
  }

  snapshot(): unknown {
    return structuredClone({ contact_type: this.state.contact_type, listings: this.state.listings, interaction_count: this.state.interactions.length });
  }

  private async route(request: IncomingMessage, response: ServerResponse): Promise<void> {
    if (request.headers["x-api-key"] !== this.apiKey) return sendJson(response, 401, { error: "unauthorized" });
    const url = new URL(request.url ?? "/", "http://localhost");
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ""));
    if (request.method === "GET" && path === "/flat/by-phone") {
      return sendJson(response, 200, { flats: this.state.listings });
    }
    if (request.method === "GET" && path.startsWith("/contacts/") && path.endsWith("/interactions")) {
      const instanceId = url.searchParams.get("instance_id");
      const rows = this.state.interactions.filter((item) => !instanceId || item.whatsapp_instance_id === instanceId);
      const limit = Number(url.searchParams.get("limit") ?? "50");
      return sendJson(response, 200, { success: true, messages: rows.slice(-limit).map((row) => ({
        ...row,
        channel: "whatsapp",
        direction: row.direction === "inbound" ? "incoming" : "outgoing",
        message_id: row.whatsapp_message_id ?? row.id,
        instance_id: row.whatsapp_instance_id ?? instanceId,
      })) });
    }
    if (request.method === "POST") {
      const body = await readJson(request);
      if (this.failNextWrite) {
        this.failNextWrite = false;
        this.writes.push({ method: request.method, path, body, before: this.snapshot(), after: this.snapshot(), statusCode: 503 });
        return sendJson(response, 503, { error: "synthetic test CRM write failure" });
      }
      const before = this.snapshot();
      if (path === "/status/set") {
        const listing = this.state.listings.find((item) => String(item.id) === String(body.id));
        if (!listing) return sendJson(response, 404, { error: "listing not found" });
        for (const item of this.state.listings) item.crm_status = String(body.status);
      } else if (/^\/contacts\/[^/]+\/type$/.test(path)) {
        this.state.contact_type = String(body.contact_type);
        for (const listing of this.state.listings) listing.contact_type = this.state.contact_type;
      } else if (/^\/contacts\/[^/]+\/deal$/.test(path)) {
        const listing = this.state.listings.find((item) => String(item.id) === String(body.listing_id));
        if (!listing) return sendJson(response, 404, { error: "listing not found" });
        for (const key of ["window_view", "complex_name", "cadastral_code", "agent_notes"] as const) {
          if (body[key] !== undefined && body[key] !== "") listing[key] = String(body[key]);
        }
      } else if (/^\/contacts\/[^/]+\/listings\/[^/]+\/rental-terms$/.test(path)) {
        const listingId = path.split("/")[4];
        const listing = this.state.listings.find((item) => String(item.id) === listingId);
        if (!listing) return sendJson(response, 404, { error: "listing not found" });
        listing.rental_terms ??= {};
        Object.assign(listing.rental_terms, body);
      } else if (path === "/chat/reply") {
        const messageId = `crm-message-${this.nextInteraction++}`;
        this.sentMessages.push({ phone: String(body.phone), instance_id: String(body.instance_id), message: String(body.message), message_id: messageId });
        this.state.interactions.push({
          id: messageId, text: String(body.message), sender: "agent", direction: "outbound", sent_at: new Date().toISOString(),
          whatsapp_message_id: messageId, whatsapp_instance_id: String(body.instance_id),
          message_id: messageId, instance_id: String(body.instance_id), channel: "whatsapp",
        });
        this.writes.push({ method: request.method, path, body, before, after: this.snapshot(), statusCode: 200 });
        return sendJson(response, 200, { success: true, message_id: messageId, instance_id: body.instance_id });
      } else {
        return sendJson(response, 404, { error: "endpoint not implemented in acceptance CRM" });
      }
      this.writes.push({ method: request.method, path, body, before, after: this.snapshot(), statusCode: 200 });
      return sendJson(response, 200, { success: true, ok: true, listing_id: body.listing_id, changed_fields: Object.keys(body) });
    }
    return sendJson(response, 404, { error: "not found" });
  }
}
