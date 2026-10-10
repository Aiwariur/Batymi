/** Read production context and exercise the real LLM against an isolated CRM/store/sender.
 * Usage: npx tsx scripts/check-cooperation-replay.ts <ssh-host> <container> <instance-id> <phone>...
 * SSH credentials and runtime secrets remain in memory; no production writes or sends.
 */
import { execFileSync } from "node:child_process";
import assert from "node:assert/strict";
import { createHarness } from "../tests/helpers/harness";
import { OpenAiCompatibleProvider } from "../src/agent/llm.provider";
import { normalizeGreenApiWebhook } from "../src/webhooks/greenapi.normalizer";
import { CrmInteraction } from "../src/crm/crm.client";
import { Listing, CrmStatus } from "../src/types";

async function main() {
const [host, container, instanceId, ...phones] = process.argv.slice(2);
assert(host && container && instanceId && phones.length, "ssh-host, container, instance-id and phones required");
assert(/^[\w.-]+$/.test(container) && /^\d+$/.test(instanceId) && phones.every(p => /^\+?\d+$/.test(p)));
const shellQuote = (value: string) => "'" + value.replace(/'/g, "'\\''") + "'";
const remote = `(async()=>{
  const env=process.env, snapshots=[];
  const read=async route=>{const r=await fetch(env.CRM_BASE_URL.replace(/\\/+$/,"")+route,{headers:{"X-API-Key":env.CRM_API_KEY}});if(!r.ok)throw Error("CRM read HTTP "+r.status);return r.json()};
  for(const phone of ${JSON.stringify(phones)}) snapshots.push({phone,
    listings:(await read('/flat/by-phone?phone='+encodeURIComponent(phone))).flats,
    interactions:(await read('/contacts/'+encodeURIComponent('+'+phone.replace(/\\D/g,''))+'/interactions?latest=1&include_first=1&type=whatsapp&instance_id=${instanceId}&limit=50')).messages});
  console.log(JSON.stringify({llm:Object.fromEntries(Object.entries(env).filter(([k])=>k.startsWith('LLM_'))),snapshots}));
})().catch(()=>{console.error('Read-only production context retrieval failed');process.exit(1)});`;
const payload = JSON.parse(execFileSync("ssh", ["-o", "BatchMode=yes", "-o", "ConnectTimeout=10", "-i",
  process.env.USERPROFILE + "/.ssh/id_ed25519", host,
  `docker exec ${container} node -e ${shellQuote(remote)}`], { encoding: "utf8", maxBuffer: 2 * 1024 * 1024 }));
for (const snapshot of payload.snapshots as { phone: string; listings: Listing[]; interactions: CrmInteraction[] }[]) {
  const incoming = snapshot.interactions.filter(row => row.direction === "incoming").at(-1);
  assert(incoming?.text, "No incoming owner text in snapshot");
  const cutoff = snapshot.interactions.indexOf(incoming);
  const history = snapshot.interactions.slice(0, cutoff);
  if (process.env.REPLAY_INSPECT === "1") console.log(JSON.stringify({ phoneSuffix: snapshot.phone.slice(-4),
    listings: snapshot.listings.map(l => ({ id: l.id, address: l.address, url: l.url })),
    history: history.map(row => ({ direction: row.direction, sender: row.sender, text: row.text, notes: row.notes })), incoming: incoming.text }));
  for (const status of ["agreed", "disagreed"] as const) {
    const h = createHarness({ OWNER_DIALOGUE_MODE: "cooperation_only", ...payload.llm });
    h.config.instances = [{ id: instanceId, token: "isolated", name: "Богдан" }];
    h.config.allowedManagerIds = [];
    h.services.llm = new OpenAiCompatibleProvider(h.config, h.services.logger);
    let modelCalls = 0;
    const realComplete = h.services.llm.complete.bind(h.services.llm);
    h.services.llm.complete = async messages => { modelCalls++; return realComplete(messages); };
    h.crm.setContactState(snapshot.phone, { status: snapshot.listings[0].crm_status as CrmStatus,
      listings: snapshot.listings.map(l => ({ id: Number(l.id), address: l.address ?? "", title: l.title ?? "" })) as never });
    const mockGet = h.crm.getListingsByPhone.bind(h.crm);
    h.services.crm.getListingsByPhone = async phone => {
      const mock = await mockGet(phone);
      return snapshot.listings.map(l => ({ ...l, crm_status: mock[0].crm_status }));
    };
    h.services.crm.getInteractions = async () => history;
    const chatId = snapshot.phone.replace(/\D/g, "") + "@c.us";
    const first = normalizeGreenApiWebhook(instanceId, { typeWebhook: "incomingMessageReceived", idMessage: "replay-owner",
      timestamp: Date.now(), senderData: { chatId }, messageData: { typeMessage: "quotedMessage", extendedTextMessageData: { text: incoming.text } } });
    assert(first?.type === "text");
    await h.ingest(first);
    const outcome = (await h.scheduler.runAll()).at(-1);
    assert.equal(outcome?.status, "processed");
    const reply = h.debug.snapshot().outgoing[0]?.message;
    assert(reply, "Owner clarification must receive a reply");
    assert.equal(await h.store.getManualHandoff(h.key(instanceId, chatId)), null, "Plain owner reply must not pause");
    assert.equal(h.debug.snapshot().crmActions.length, 0, "Clarification must not decide cooperation");
    const selected = snapshot.listings.find(l => l.url && reply.includes(l.url));
    assert(selected, "Clarification must include the real external listing URL");
    const terminalText = status === "agreed" ? "Да, согласна сотрудничать с вашим агентством по сдаче этой квартиры" : "Нет, с агентствами не сотрудничаю";
    await h.ingest(h.makeMessage({ instanceId, chatId, text: terminalText }));
    const terminal = (await h.scheduler.runAll()).at(-1);
    assert.equal(terminal?.status, "processed");
    assert.equal((await h.services.crm.getListingsByPhone(snapshot.phone))[0].crm_status, status);
    assert.equal(h.debug.snapshot().outgoing.length, 1, "Cooperation decision must hand off without more messages");
    const before = modelCalls;
    await h.ingest(h.makeMessage({ instanceId, chatId, text: "Ещё вопрос" }));
    await h.scheduler.runAll();
    assert.equal(modelCalls, before, "Terminal contact must not restart the LLM");
    assert.equal(h.debug.snapshot().outgoing.length, 1);
    console.log(JSON.stringify({ phoneSuffix: snapshot.phone.slice(-4), ownerText: incoming.text, listingId: selected.id, address: selected.address, reply, terminal: status,
      modelCalls, productionWrites: 0, providerSends: 0, passed: true }));
  }
}
}
main().catch(error => { console.error(error.message); process.exitCode = 1; });
