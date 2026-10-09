import { z } from "zod";
import { Config } from "../config/env";
import { InstanceConfig } from "../config/instances";

const registrySchema = z.array(z.object({
  instanceId: z.string().trim().min(1),
  name: z.string(),
  isActive: z.boolean(),
}));

/** The authenticated CRM registry owns membership; env may only retain routing overrides. */
export class CrmInstanceRegistry {
  private refreshedAt = 0;
  private pending?: Promise<void>;
  private readonly overrides: InstanceConfig[];

  constructor(private readonly config: Config) {
    this.overrides = [...config.instances];
  }

  async refresh(force = false): Promise<void> {
    if (this.pending) return this.pending;
    if (!force && this.refreshedAt && Date.now() - this.refreshedAt < 30000) return;
    this.pending = this.load();
    try { await this.pending; } finally { this.pending = undefined; }
  }

  async resolve(instanceId: string): Promise<InstanceConfig | undefined> {
    await this.refresh();
    let instance = this.config.instances.find(row => row.id === instanceId);
    if (!instance) {
      await this.refresh(true);
      instance = this.config.instances.find(row => row.id === instanceId);
    }
    return instance;
  }

  private async load(): Promise<void> {
    if (!this.config.crmBaseUrl || !this.config.crmApiKey) throw Error("CRM instance registry requires CRM credentials");
    const response = await fetch(`${this.config.crmBaseUrl}/whatsapp-instances`, {
      headers: { "X-API-Key": this.config.crmApiKey }, signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error(`CRM instance registry failed: HTTP ${response.status}`);
    const rows = registrySchema.parse(await response.json());
    if (new Set(rows.map(row => row.instanceId)).size !== rows.length) throw Error("CRM instance registry contains duplicate IDs");
    const instances = rows.filter(row => row.isActive).map(row => ({
      ...this.overrides.find(override => override.id === row.instanceId),
      id: row.instanceId, name: row.name, token: "",
    }));
    this.config.instances = instances;
    this.refreshedAt = Date.now();
  }
}
