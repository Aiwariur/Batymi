import { z } from "zod";

export interface InstanceConfig {
  id: string;
  token: string;
  managerId?: number;
  name?: string;
}

const instanceSchema = z.object({
  id: z.union([z.string(), z.number()]).transform((v) => String(v)),
  token: z.string().default(""),
  managerId: z.union([z.string(), z.number()]).optional().transform((v) => (v === undefined ? undefined : Number(v))),
  name: z.string().optional(),
});

function parseJsonInstances(raw: string | undefined): InstanceConfig[] {
  if (!raw || !raw.trim()) return [];
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    throw new Error("GREENAPI_INSTANCES is not valid JSON");
  }
  const list = Array.isArray(json) ? json : [json];
  const result = z.array(instanceSchema).safeParse(list);
  if (!result.success) {
    throw new Error(`GREENAPI_INSTANCES invalid: ${result.error.issues.map((i) => i.message).join("; ")}`);
  }
  return result.data.map((item) => ({
    id: item.id,
    token: item.token,
    managerId: Number.isFinite(item.managerId) ? item.managerId : undefined,
    name: item.name,
  }));
}

function parseNumberedInstances(env: NodeJS.ProcessEnv): InstanceConfig[] {
  const instances: InstanceConfig[] = [];
  for (let i = 1; i <= 50; i += 1) {
    const id = env[`GREENAPI_INSTANCE_${i}_ID`];
    const token = env[`GREENAPI_INSTANCE_${i}_TOKEN`];
    if (!id && !token) continue;
    if (!id) throw new Error(`GREENAPI_INSTANCE_${i}_ID is missing`);
    const managerRaw = env[`GREENAPI_INSTANCE_${i}_MANAGER_ID`];
    instances.push({
      id: String(id).trim(),
      token: token ? String(token).trim() : "",
      managerId: managerRaw ? Number(managerRaw) : undefined,
      name: env[`GREENAPI_INSTANCE_${i}_NAME`],
    });
  }
  return instances;
}

function buildMockInstances(): InstanceConfig[] {
  return Array.from({ length: 5 }, (_, index) => ({
    id: `mock-instance-${index + 1}`,
    token: `mock-token-${index + 1}`,
    managerId: 2,
    name: `Mock instance ${index + 1}`,
  }));
}

export function parseInstances(env: NodeJS.ProcessEnv, mockExternals: boolean): InstanceConfig[] {
  const json = parseJsonInstances(env.GREENAPI_INSTANCES);
  const numbered = parseNumberedInstances(env);

  const seen = new Set<string>();
  const merged: InstanceConfig[] = [];
  for (const instance of [...json, ...numbered]) {
    if (seen.has(instance.id)) continue;
    seen.add(instance.id);
    merged.push(instance);
  }

  if (merged.length === 0 && mockExternals) {
    return buildMockInstances();
  }
  return merged;
}
