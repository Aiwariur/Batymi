import { Config } from "../config/env";
import { isWaApiLid, isWaApiPhone } from "../webhooks/waapi.normalizer";

/** Resolve only provider-returned PN for the requested LID; never strip digits from an opaque id. */
export async function resolveWaApiChat(config: Config, instanceId: string, rawChatId: string): Promise<string | undefined> {
  if (isWaApiPhone(rawChatId)) return rawChatId;
  if (!isWaApiLid(rawChatId)) return undefined;
  if (!config.waapiApiToken) throw Error("WaAPI account token is not configured");
  const instance = config.instances.find(row => row.id === instanceId && row.provider === "waapi");
  if (!instance) throw Error("WaAPI instance unavailable");
  try {
    const response = await fetch(`${instance.baseUrl || config.waapiBaseUrl}/instances/${encodeURIComponent(instanceId)}/client/action/get-lid`, {
      method: "POST", headers: { Authorization: `Bearer ${config.waapiApiToken}`, "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ contactIds: [rawChatId] }), signal: AbortSignal.timeout(15000),
    });
    if (!response.ok) throw Error("request failed");
    const body = await response.json() as { status?: string; data?: { status?: string; data?: { contacts?: { lid?: string; pn?: string }[] } } };
    if (body.status !== "success" || body.data?.status !== "success") throw Error("action failed");
    const pairs = body.data.data?.contacts;
    if (!Array.isArray(pairs)) throw Error("invalid response");
    const match = pairs.find(pair => pair.lid === rawChatId && typeof pair.pn === "string" && isWaApiPhone(pair.pn));
    return match?.pn;
  } catch { throw Error("WaAPI LID resolution unavailable"); }
}
