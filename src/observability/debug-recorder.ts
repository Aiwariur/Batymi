import { CrmActionRecord, ForwardedWebhookRecord, OutgoingMessage } from "../types";

export interface DebugSnapshot {
  outgoing: OutgoingMessage[];
  crmActions: CrmActionRecord[];
  forwardedWebhooks: ForwardedWebhookRecord[];
}

/**
 * Development/test only recorder that keeps a small in-memory log of mocked
 * outgoing WhatsApp messages and mocked CRM actions. It is intentionally tiny
 * and has no effect on the production flow.
 */
export interface DebugRecorder {
  recordOutgoing(message: OutgoingMessage): void;
  recordCrmAction(action: string, payload: unknown): void;
  recordForwardedWebhook(instanceId: string, payload: unknown): void;
  snapshot(): DebugSnapshot;
  reset(): void;
}

const MAX_ENTRIES = 500;

export class InMemoryDebugRecorder implements DebugRecorder {
  private outgoing: OutgoingMessage[] = [];
  private crmActions: CrmActionRecord[] = [];
  private forwardedWebhooks: ForwardedWebhookRecord[] = [];

  recordOutgoing(message: OutgoingMessage): void {
    this.outgoing.push(message);
    if (this.outgoing.length > MAX_ENTRIES) this.outgoing.shift();
  }

  recordCrmAction(action: string, payload: unknown): void {
    this.crmActions.push({ ts: Date.now(), action, payload });
    if (this.crmActions.length > MAX_ENTRIES) this.crmActions.shift();
  }

  recordForwardedWebhook(instanceId: string, payload: unknown): void {
    this.forwardedWebhooks.push({ ts: Date.now(), instanceId, payload });
    if (this.forwardedWebhooks.length > MAX_ENTRIES) this.forwardedWebhooks.shift();
  }

  snapshot(): DebugSnapshot {
    return {
      outgoing: [...this.outgoing],
      crmActions: [...this.crmActions],
      forwardedWebhooks: [...this.forwardedWebhooks],
    };
  }

  reset(): void {
    this.outgoing = [];
    this.crmActions = [];
    this.forwardedWebhooks = [];
  }
}
