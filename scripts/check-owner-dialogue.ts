import { mkdir, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { OpenAiCompatibleProvider } from "../src/agent/llm.provider";
import { PROMPT_VERSION } from "../src/agent/system-prompt";
import { ownerDialogueCorpus, OwnerDialogueScenario } from "../tests/conversations/owner-dialogue-corpus";
import { CountingLlmProvider, createOwnerDialogueRuntime, getPath, primaryListingSnapshot, runOwnerDialogueTurn, ScriptedOwnerDialogueLlm, writeSignature } from "../tests/helpers/owner-dialogue-runner";

interface TurnReport {
  sequence: number;
  ownerText: string;
  runId?: string;
  outcome?: unknown;
  before?: unknown;
  after?: unknown;
  crmWrites?: unknown[];
  assistantReply?: string | null;
  modelOutputs?: string[];
  attempts?: unknown[];
  crmInteractions?: unknown[];
  modelCalls?: { before: number; after: number };
  cumulativeWrites?: number;
  cumulativeSends?: number;
  duplicateWebhookAccepted?: boolean;
  invariants: string[];
  error?: string;
}

interface ScenarioReport { id: string; title: string; turns: TurnReport[]; }
const scriptedMode = process.argv.includes("--scripted");

function scenarios(): OwnerDialogueScenario[] {
  const available = ownerDialogueCorpus.flatMap((scenario) => [scenario, ...(scenario.alternates ?? [])]);
  const selection = process.argv.find((argument) => argument.startsWith("--scenario="));
  if (!selection) return available;
  const requested = selection.slice("--scenario=".length).split(",").map((id) => id.trim()).filter(Boolean);
  if (requested.length === 0) throw new Error("--scenario requires one or more comma-separated scenario IDs");
  const byId = new Map(available.map((scenario) => [scenario.id, scenario]));
  const unknown = requested.filter((id) => !byId.has(id));
  if (unknown.length) throw new Error(`Unknown owner dialogue scenario ID(s): ${unknown.join(", ")}. Available IDs: ${[...byId.keys()].join(", ")}`);
  return [...new Set(requested)].map((id) => byId.get(id)!);
}

function safeValue<T>(value: T, secrets: string[]): T {
  const encoded = JSON.stringify(value);
  const scrubbed = secrets.filter(Boolean).reduce((text, secret) => text.split(secret).join("[redacted]"), encoded);
  return JSON.parse(scrubbed) as T;
}

function evaluateInvariants(input: {
  scenario: OwnerDialogueScenario;
  turnIndex: number;
  turn: OwnerDialogueScenario["turns"][number];
  outcome: { status: string; reply?: string; stopConversation?: boolean };
  before: unknown;
  after: unknown;
  crmWrites: Array<{ path?: string; body?: Record<string, unknown> }>;
  sentMessages: Array<{ message: string; message_id: string }>;
  interactions: Array<{ id: string }>;
  modelCallsBefore: number;
  modelCallsAfter: number;
  totalSentAfter: number;
  totalWritesAfter: number;
  attempts: Array<{ outcome: { status: string }; after: unknown; sentCount: number }>;
}): string[] {
  const issues: string[] = [];
  const expected = input.turn.expect;
  const listing = primaryListingSnapshot(input.after, expected.listingId ?? input.scenario.listingIds?.[0]);
  const contactType = (input.after as { contact_type?: string | null }).contact_type;
  if (expected.status && listing.crm_status !== expected.status) issues.push(`CRM status expected ${expected.status}, received ${String(listing.crm_status)}`);
  if (expected.contactType !== undefined && contactType !== expected.contactType) issues.push(`contact type expected ${String(expected.contactType)}, received ${String(contactType)}`);
  for (const [field, wanted] of Object.entries(expected.fields ?? {})) {
    const actual = getPath(listing, field);
    const allowed = !scriptedMode && expected.liveFields?.[field] ? expected.liveFields[field] : [wanted];
    if (!allowed.some((value) => JSON.stringify(actual) === JSON.stringify(value))) {
      issues.push(`CRM field ${field} expected ${JSON.stringify(allowed.length === 1 ? allowed[0] : allowed)}, received ${JSON.stringify(actual)}`);
    }
  }
  for (const field of expected.absentFields ?? []) {
    if (getPath(listing, field) != null) issues.push(`CRM field ${field} should remain empty, received ${JSON.stringify(getPath(listing, field))}`);
  }
  if (expected.sendCount !== undefined && input.totalSentAfter !== expected.sendCount) issues.push(`cumulative sends expected ${expected.sendCount}, received ${input.totalSentAfter}`);
  if (expected.writeCount !== undefined && input.totalWritesAfter !== expected.writeCount) issues.push(`cumulative CRM writes expected ${expected.writeCount}, received ${input.totalWritesAfter}`);
  const actualSignatures = input.crmWrites.map(writeSignature);
  if (expected.writeSignatures && JSON.stringify(scriptedMode ? actualSignatures : [...actualSignatures].sort()) !== JSON.stringify(scriptedMode ? expected.writeSignatures : [...expected.writeSignatures].sort())) issues.push(`write actions differ: ${JSON.stringify(actualSignatures)}`);
  if (expected.runStatus && input.outcome.status !== expected.runStatus) issues.push(`run status expected ${expected.runStatus}, received ${input.outcome.status}`);
  if (expected.stopConversation !== undefined && input.outcome.stopConversation !== expected.stopConversation) issues.push(`stopConversation expected ${expected.stopConversation}, received ${String(input.outcome.stopConversation)}`);
  if (expected.runModel === false && input.modelCallsAfter !== input.modelCallsBefore) issues.push("LLM was called on a terminal or manager-owned turn");
  if (expected.runModel === true && input.modelCallsAfter <= input.modelCallsBefore) issues.push("LLM was not called for an actionable owner turn");
  if (expected.runStatus === "failed" && input.sentMessages.length > 0) issues.push("owner-facing reply was sent after a CRM write failed");
  if (expected.runStatus === "failed" && listing.crm_status === "qualified") issues.push("CRM failure still left contact qualified");
  if (input.turn.failCrmWrite) {
    const failed = input.attempts[0];
    const failedListing = primaryListingSnapshot(failed?.after);
    if (!failed || failed.outcome.status !== "rescheduled") issues.push("transient CRM error did not schedule a retry");
    if (failed?.sentCount !== 0) issues.push("transient CRM error sent an owner-facing reply before retry");
    if (failedListing.crm_status === "qualified" || (failed?.after as { contact_type?: string | null }).contact_type === "owner") issues.push("CRM state advanced before its failed write was retried");
    if (input.attempts[1]?.outcome.status !== "processed") issues.push("transient CRM error retry did not complete successfully");
  }
  if (listing.crm_status === "qualified") {
    if (input.scenario.listingIds && input.scenario.listingIds.length > 1) issues.push("contact qualified while multiple listings remained unresolved");
    if (contactType !== "owner") issues.push("qualified contact is not recorded as owner");
    for (const key of ["price", "currency", "minimum_lease_months"] as const) {
      if (!getPath(listing, `rental_terms.${key}`)) issues.push(`qualified listing is missing ${key}`);
    }
  }
  const allowed = new Set((input.scenario.listingIds ?? [101]).map(String));
  const selectedListingId = input.turn.expect.listingId ?? (input.scenario.listingIds?.length === 1 ? input.scenario.listingIds[0] : undefined);
  for (const write of input.crmWrites) {
    const match = write.path?.match(/\/listings\/([^/]+)\/rental-terms$/);
    if (!write.path || !(write.path === "/status/set" || write.path === "/chat/reply" || /\/contacts\/[^/]+\/type$/.test(write.path) || /\/contacts\/[^/]+\/deal$/.test(write.path) || /\/contacts\/[^/]+\/listings\/[^/]+\/rental-terms$/.test(write.path))) {
      issues.push(`CRM write used an unapproved endpoint: ${String(write.path)}`);
    }
    if (write.path === "/status/set" && !["agreed", "qualified", "disagreed"].includes(String(write.body?.status))) {
      issues.push(`CRM status write used a disallowed status: ${String(write.body?.status)}`);
    }
    if (write.path === "/status/set" && !allowed.has(String(write.body?.id))) issues.push(`CRM status write targeted unlisted listing ${String(write.body?.id)}`);
    if (write.path === "/status/set" && selectedListingId !== undefined && String(write.body?.id) !== String(selectedListingId)) issues.push(`CRM status write targeted ${String(write.body?.id)}, while this turn selected ${String(selectedListingId)}`);
    if (/\/contacts\/[^/]+\/type$/.test(write.path ?? "") && !["owner", "realtor", "potential_owner"].includes(String(write.body?.contact_type))) {
      issues.push(`contact type write used a disallowed value: ${String(write.body?.contact_type)}`);
    }
    if (match && !allowed.has(match[1])) issues.push(`rental terms were written to unlisted listing ${match[1]}`);
    if (match && selectedListingId !== undefined && match[1] !== String(selectedListingId)) issues.push(`rental terms were written to ${match[1]}, while this turn selected ${String(selectedListingId)}`);
    if (match) {
      const allowedFields = new Set(["price", "currency", "price_period", "available_from", "deposit_amount", "prepayment_months", "minimum_lease_months", "availability_status", "lease_terms_notes", "commission_type", "commission_value", "commission_payer", "commission_notes"]);
      for (const field of Object.keys(write.body ?? {})) if (!allowedFields.has(field)) issues.push(`rental write used a disallowed field: ${field}`);
    }
    if (/\/contacts\/[^/]+\/deal$/.test(write.path ?? "")) {
      const allowedFields = new Set(["listing_id", "window_view", "complex_name", "cadastral_code", "agent_notes"]);
      for (const field of Object.keys(write.body ?? {})) if (!allowedFields.has(field)) issues.push(`deal write used a disallowed field: ${field}`);
      if (!allowed.has(String(write.body?.listing_id))) issues.push(`deal write targeted unlisted listing ${String(write.body?.listing_id)}`);
      if (selectedListingId !== undefined && String(write.body?.listing_id) !== String(selectedListingId)) issues.push(`deal write targeted ${String(write.body?.listing_id)}, while this turn selected ${String(selectedListingId)}`);
    }
    if (write.path === "/chat/reply" && String(write.body?.instance_id) !== "acceptance-instance") issues.push("reply was sent from the wrong WhatsApp instance");
    if (write.path === "/status/set" && input.scenario.listingIds?.length && input.scenario.listingIds.length > 1 && String(write.body?.status) === "qualified") {
      issues.push("multi-listing contact was moved to qualified");
    }
  }
  for (const sent of input.sentMessages) {
    if (!input.interactions.some((interaction) => interaction.id === sent.message_id)) issues.push("CRM reply sender returned without persisting its Interaction");
    if (/\bpublished\b|publication is ready|готовим публикацию|объявление опубликовано/i.test(sent.message)) issues.push("reply claims publication without a publication action");
    if ((sent.message.match(/[?？]/g) ?? []).length > 1) issues.push("reply asks more than one question");
    if (/кадастр|cadastr/i.test(sent.message)) issues.push("reply introduces an unsolicited cadastral question");
    if (/\bqualified\b|\bCRM\b|квалифицирован|передаю.{0,30}(?:менеджер|клиент)|передам.{0,30}(?:менеджер|клиент)/i.test(sent.message)) issues.push("reply exposes internal workflow or claims an unexecuted handoff");
  }
  if (input.sentMessages.length === 0 && input.outcome.reply) {
    issues.push("run reports an owner-facing reply when no CRM send occurred");
  }
  const reply = input.sentMessages.at(-1)?.message;
  if (reply) {
    const replyIncludes = scriptedMode ? expected.replyIncludes : expected.liveReplyIncludes ?? expected.replyIncludes;
    for (const fragment of replyIncludes ?? []) {
      const pattern = fragment.toLocaleLowerCase();
      const matchers: Record<string, RegExp> = {
        "собственник": /собственник|владелец|owner/i,
        "сотрудничать": /сотруднич|работать с агентств|cooperat|work with/i,
        "sotrudnichat": /sotrud|cooperat|work with/i,
        "цена": /цен|стоим|price|rent/i,
        "жк": /жк|комплекс|residential complex/i,
        "комисси": /комисси|commission/i,
        "агентств": /агентств|agency/i,
        "მადლობა": /მადლობ/i,
        "thanks": /thank|appreciat|noted/i,
        "декабря": /декабр|december/i,
        "вид на море": /вид.{0,24}мор|мор.{0,24}вид|sea.{0,8}view/i,
        "минимальн": /минимальн|minimum|least.{0,12}year/i,
        "kobaladze 12": /kobaladze\s*[,#-]?\s*12/i,
        "listing-address-choice": /адрес.{0,100}[?？]|(?=.*kobaladze\s*[,#-]?\s*12)(?=.*demo\s+street\s*[,#-]?\s*202)(?=.*[?？])/is,
      };
      if (!(matchers[pattern] ?? new RegExp(fragment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"), "i")).test(reply)) issues.push(`reply does not answer expected concept '${fragment}'`);
    }
    for (const fragment of expected.replyExcludes ?? []) {
      if (fragment.toLocaleLowerCase() === "id" && /\b(?:id|listing id|внутренний номер)\b/i.test(reply)) issues.push("reply exposes an internal listing ID");
      if (/publish|публикац/i.test(fragment) && /publish|публикац/i.test(reply)) issues.push("reply claims listing publication without a publication action");
      if (fragment.toLocaleLowerCase().includes("готовы сотрудничать") && /готовы сотрудничать/i.test(reply)) issues.push("reply repeats the cooperation question after it was answered");
      if (fragment === "asks-price" && /(?:какая|сколько|назовите|уточните).{0,35}(?:цен|стоим)|(?:what|how much).{0,25}(?:price|rent)/i.test(reply)) issues.push("reply asks for a price already supplied in this turn");
      if (fragment === "asks-minimum-term" && /(?:какой|какова|уточните|назовите).{0,35}(?:минимальн|срок)|(?:what|how long).{0,25}(?:minimum|term|lease)/i.test(reply)) issues.push("reply asks for a minimum lease term already supplied in this turn");
      if (fragment === "claims-crm-write" && /записал|зафиксировал|сохранил|recorded|saved/i.test(reply)) issues.push("reply claims a CRM write before listing selection");
    }
  }
  return issues;
}

async function main(): Promise<void> {
  const scenariosToRun = scenarios();
  const reports: ScenarioReport[] = [];
  let modelAlias = scriptedMode ? "scripted" : "configured";
  const concurrencyArg = process.argv.find(argument => argument.startsWith("--concurrency="));
  const concurrency = concurrencyArg ? Number(concurrencyArg.slice("--concurrency=".length)) : 1;
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 3) throw new Error("--concurrency must be 1..3");
  const queue = scenariosToRun.entries();
  async function runWorker(): Promise<void> {
  for (const [scenarioIndex, scenario] of queue) {
    const turnReports: TurnReport[] = [];
    let provider: CountingLlmProvider | undefined;
    const runtime = await createOwnerDialogueRuntime(scenario, (_turns, config, logger) => {
      if (scriptedMode) provider = new ScriptedOwnerDialogueLlm(_turns) as unknown as CountingLlmProvider;
      else {
        modelAlias = config.llmModel;
        provider = new CountingLlmProvider(new OpenAiCompatibleProvider(config, logger));
      }
      return provider;
    });
    process.stdout.write(`[${scenario.id}] starting (${scenario.turns.length} turns)\n`);
    try {
      for (const [index, turn] of scenario.turns.entries()) {
        try {
          const record = await runOwnerDialogueTurn(runtime, turn, index + 1);
          const sentMessages = record.sentMessages as Array<{ message: string; message_id: string }>;
          const interactions = runtime.crm.state.interactions.map((item) => ({ id: item.id }));
          const invariants = evaluateInvariants({
            scenario, turnIndex: index, turn, outcome: record.outcome, before: record.before, after: record.after,
            crmWrites: record.writeEvents as Array<{ path?: string; body?: Record<string, unknown> }>,
            sentMessages, interactions, modelCallsBefore: record.modelCallsBefore, modelCallsAfter: record.modelCallsAfter,
            totalSentAfter: record.totalSentAfter, totalWritesAfter: record.totalWritesAfter,
            attempts: record.attempts as Array<{ outcome: { status: string }; after: unknown; sentCount: number }>,
          });
          turnReports.push({
            sequence: index + 1, ownerText: turn.ownerText, runId: record.runId, outcome: record.outcome,
            before: record.before, after: record.after, crmWrites: record.writeEvents,
            assistantReply: sentMessages.at(-1)?.message ?? null, modelOutputs: record.modelOutputs,
            attempts: record.attempts, crmInteractions: structuredClone(runtime.crm.state.interactions), invariants,
            modelCalls: { before: record.modelCallsBefore, after: record.modelCallsAfter },
            cumulativeWrites: record.totalWritesAfter, cumulativeSends: record.totalSentAfter,
            duplicateWebhookAccepted: record.duplicateAccepted,
          });
          process.stdout.write(`[${scenario.id}] turn ${index + 1}: ${record.outcome.status}; ${invariants.length ? `${invariants.length} issue(s)` : "invariants passed"}\n`);
        } catch (error) {
          turnReports.push({ sequence: index + 1, ownerText: turn.ownerText, invariants: ["turn execution failed"], error: (error as Error).message.slice(0, 400) });
          process.stdout.write(`[${scenario.id}] turn ${index + 1}: execution failed\n`);
        }
      }
    } finally {
      await runtime.close();
    }
    reports[scenarioIndex] = { id: scenario.id, title: scenario.title, turns: turnReports };
  }
  }
  await Promise.all(Array.from({ length: concurrency }, () => runWorker()));
  const apiKey = process.env.LLM_API_KEY ?? "";
  const mode = scriptedMode
    ? "scripted LLM; local synthetic CRM; no WhatsApp transport"
    : "configured OpenAI-compatible LLM; local synthetic CRM; no WhatsApp transport";
  const output = safeValue({ generatedAt: new Date().toISOString(), mode, modelAlias, promptVersion: PROMPT_VERSION, scenarios: reports }, [apiKey]);
  const reportDir = path.resolve(process.env.OWNER_DIALOGUE_REPORT_DIR ?? path.join(os.tmpdir(), "batymi-owner-dialogue-acceptance"));
  await mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, `owner-dialogue-${new Date().toISOString().replace(/[:.]/g, "-")}.json`);
  await writeFile(reportPath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
  const allIssues = reports.flatMap((scenario) => scenario.turns.flatMap((turn) => turn.invariants.map((issue) => `${scenario.id}#${turn.sequence}: ${issue}`)));
  process.stdout.write(`Owner dialogue replay: ${reports.length} scenarios, ${reports.reduce((sum, item) => sum + item.turns.length, 0)} turns.\n`);
  process.stdout.write(`Synthetic CRM report: ${reportPath}\n`);
  if (allIssues.length) {
    process.stdout.write(`Invariant issues: ${allIssues.length}\n${allIssues.map((issue) => `- ${issue}`).join("\n")}\n`);
    process.exitCode = 1;
  } else process.stdout.write("All CRM state, write-scope, reply, and terminal-silence invariants passed.\n");
}

  if (!scriptedMode && !process.env.LLM_API_KEY) {
  process.stderr.write("LLM_API_KEY is required for this live-provider acceptance replay. No CRM or WhatsApp service is contacted.\n");
  process.exitCode = 2;
} else {
  void main().catch((error) => {
    process.stderr.write(`Owner dialogue replay could not complete: ${(error as Error).message}\n`);
    process.exitCode = 1;
  });
}
