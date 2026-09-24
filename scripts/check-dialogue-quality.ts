import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import assert from "node:assert/strict";
import { loadConfig } from "../src/config/env";
import { createLogger } from "../src/observability/logger";
import { ChatMessage, createLlmProvider, LlmError, LlmProvider } from "../src/agent/llm.provider";
import { resolvePhase, buildSystemPrompt } from "../src/agent/system-prompt";
import { runAgent } from "../src/agent/agent";
import { finalizeAgentResponse } from "../src/conversation/conversation.service";
import { Listing } from "../src/types";
import { applyActions } from "../tests/conversations/evaluate";
import { baseListing } from "../tests/conversations/scenarios";

interface TurnRecord {
  user: string;
  statusBefore: string;
  statusAfter: string;
  contactType: string;
  raw: string;
  reply: string;
  actions: unknown[];
  stopped: boolean;
}

interface DialogueResult {
  name: string;
  turns: TurnRecord[];
  failures: string[];
  listing: Listing;
}

const logger = createLogger({ level: "error", pretty: false });
const config = loadConfig({ ...process.env, MOCK_LLM: "false" });
assert.ok(config.llmApiKey, "LLM_API_KEY is required; value is never printed");
const provider = createLlmProvider(config, logger);
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));
const llm: LlmProvider = {
  async complete(messages: ChatMessage[]) {
    for (let attempt = 1; ; attempt += 1) {
      try {
        return await provider.complete(messages);
      } catch (error) {
        if (!(error instanceof LlmError) || !error.retryable || attempt >= 3) throw error;
        logger.warn({ attempt }, "dialogue_check.llm.retry");
        await sleep(1000 * attempt);
      }
    }
  },
};

async function runDialogue(
  name: string,
  listing: Listing,
  initialHistory: Array<{ role: "assistant" | "user"; content: string }>,
  messages: string[],
): Promise<DialogueResult> {
  const history = initialHistory.map((entry) => ({ ...entry, ts: Date.now() }));
  const turns: TurnRecord[] = [];
  const failures: string[] = [];

  for (const user of messages) {
    const statusBefore = String(listing.crm_status ?? "");
    const phase = resolvePhase(listing.crm_status);
    const systemPrompt = buildSystemPrompt({
      crm: { phone: listing.phone ?? "", contact: null, listings: [listing] },
      listings: [listing],
      primaryListing: listing,
      phase,
    });
    const { result, raw } = await runAgent(llm, logger, { systemPrompt, history, batchText: user });
    const guarded = finalizeAgentResponse({
      result,
      phase,
      history,
      batchText: user,
      listings: [listing],
      primaryListing: listing,
    });
    applyActions(listing, guarded.gate.allowed);
    history.push({ role: "user", content: user, ts: Date.now() });
    history.push({ role: "assistant", content: guarded.reply, ts: Date.now() });
    turns.push({
      user,
      statusBefore,
      statusAfter: String(listing.crm_status ?? ""),
      contactType: String(listing.contact_type ?? "<unset>"),
      raw,
      reply: guarded.reply,
      actions: guarded.gate.allowed,
      stopped: guarded.stopConversation,
    });
    if (guarded.stopConversation) break;
  }

  for (const [index, turn] of turns.entries()) {
    if (!turn.reply.trim()) failures.push(`turn ${index + 1}: empty final reply`);
    if (/как могу помочь|что вас интересует|автоматическ.*предложен|по этому контакту|пару уточнений:\s*$/iu.test(turn.reply)) {
      failures.push(`turn ${index + 1}: generic, dangling, or internal wording in final reply`);
    }
  }
  return { name, turns, failures, listing };
}

async function main(): Promise<void> {
  const opening = "Здравствуйте! Пишу по вашему объявлению «Аренда 2-комнатная квартира, Батуми». Квартира ещё сдаётся на длительный срок?";
  const primaryListing = structuredClone(baseListing);
  const acquisition = await runDialogue(
    "outbound greeting, owner qualification, terms, and phase-two facts",
    primaryListing,
    [{ role: "assistant", content: opening }],
    [
      "Добрый день",
      "Да, активно",
      "Да, я собственник",
      "Да, готова сотрудничать с агентством",
      "Цена 500 долларов в месяц, депозит 500 долларов, минимальный срок 12 месяцев",
      "Вид на море, ЖК Orbi City",
    ],
  );
  const identificationListing = structuredClone(baseListing);
  const identification = await runDialogue(
    "listing identification followed by realtor disclosure",
    identificationListing,
    [{ role: "assistant", content: opening }],
    ["О какой квартире речь?", "Да, я агент, квартира сдаётся на год"],
  );
  const commissionListing = structuredClone(baseListing);
  commissionListing.contact_type = "owner";
  commissionListing.crm_status = "agreed";
  commissionListing.window_view = "море";
  commissionListing.complex_name = "Orbi City";
  commissionListing.rental_terms = {
    ...commissionListing.rental_terms,
    availability_status: "available",
    minimum_lease_months: 12,
  };
  const commission = await runDialogue(
    "owner asks an unrecorded commission question",
    commissionListing,
    [{ role: "assistant", content: "Какой вид из окон? В каком ЖК находится квартира?" }],
    ["А какую комиссию вы берёте?"],
  );
  const transliteratedListing = structuredClone(baseListing);
  transliteratedListing.rental_terms = {
    ...transliteratedListing.rental_terms,
    availability_status: "available",
  };
  const transliterated = await runDialogue(
    "screenshot regression: Lana gives owner, price, and minimum term in short transliterated replies",
    transliteratedListing,
    [
      { role: "assistant", content: "Здравствуйте! Объявление актуально? Интересует долгосрочная аренда." },
      { role: "user", content: "Da aktualno" },
      { role: "assistant", content: "Вы собственник этой квартиры? Какая цена в месяц, депозит и минимальный срок?" },
    ],
    ["Da ia sobstvenik, ia lana", "800$", "Minimalni 6 mesiacev"],
  );
  const sideQuestionListing = structuredClone(baseListing);
  sideQuestionListing.contact_type = "owner";
  sideQuestionListing.crm_status = "delivered";
  const sideQuestion = await runDialogue(
    "owner asks about current clients before agreeing",
    sideQuestionListing,
    [
      { role: "user", content: "Я собственник квартиры" },
      { role: "assistant", content: "Вы готовы сотрудничать с агентством?" },
    ],
    ["А сколько у вас сейчас клиентов?"],
  );
  const results = [acquisition, identification, commission, transliterated, sideQuestion];
  const failures = results.flatMap((result) => result.failures.map((failure) => `${result.name}: ${failure}`));
  const collectAssertions = (name: string, verify: () => void) => {
    try {
      verify();
    } catch (error) {
      failures.push(`${name}: ${(error as Error).message}`);
    }
  };
  collectAssertions(acquisition.name, () => {
    assert.ok(acquisition.turns.length >= 5, "dialogue should reach terms and property details");
    assert.equal(acquisition.turns[1]?.statusAfter, "delivered", "availability alone must not mark cooperation agreed");
    assert.equal(acquisition.turns[2]?.contactType, "owner", "explicit ownership should be recorded");
    assert.equal(acquisition.turns[3]?.statusAfter, "agreed", "explicit cooperation should advance to agreed");
    assert.equal(acquisition.listing.crm_status, "qualified", "complete long-term rental facts should qualify the listing");
    assert.equal(acquisition.listing.rental_terms?.availability_status, "available");
  });
  collectAssertions(identification.name, () => {
    assert.ok(/Kobaladze|Batumi|Батуми|Шериф/i.test(identification.turns[0]?.reply ?? ""), "identification response should refer to the listing");
    assert.ok(!/собственник|владелец/i.test(identification.turns[0]?.reply ?? ""), "identification answer should not append an unrelated owner question");
    assert.equal(identification.listing.contact_type, "realtor", "agent disclosure should classify the contact");
    assert.equal(identification.turns.at(-1)?.stopped, true, "realtor disclosure should end owner-acquisition flow");
  });
  collectAssertions(commission.name, () => {
    assert.equal(commission.listing.crm_status, "agreed", "a commission question must not complete the listing");
    assert.ok(!/\b\d+\s*%|\b\d{2,5}\s*(?:usd|доллар)/i.test(commission.turns[0]?.reply ?? ""), "do not invent a commission amount");
  });
  collectAssertions(transliterated.name, () => {
    assert.equal(transliterated.listing.contact_type, "owner", "transliterated owner confirmation should be recorded");
    assert.equal(transliterated.listing.rental_terms?.price, 800, "the dollar amount should be retained as rent");
    assert.equal(transliterated.listing.rental_terms?.minimum_lease_months, 6, "the transliterated minimum lease should be recorded");
    assert.equal(transliterated.listing.crm_status, "delivered", "partial details without cooperation consent must not advance status");
    const lastReply = transliterated.turns.at(-1)?.reply ?? "";
    assert.match(lastReply, /\?|？/, "after the minimum term, ask a useful remaining question");
    assert.ok(/депозит|сотруднич|работать с агентств/i.test(lastReply), "ask about the remaining deposit or cooperation");
    assert.ok(!/^(принял|записал цену|записал минимальный срок)[^?？]*[.!]?$/i.test(lastReply.trim()), "do not end on a bare receipt");
  });
  collectAssertions(sideQuestion.name, () => {
    assert.equal(sideQuestion.listing.crm_status, "delivered", "a side question must not grant cooperation consent");
    assert.match(sideQuestion.turns[0]?.reply ?? "", /клиент/i, "answer the owner's client-count question substantively");
    assert.ok(!/много\s+клиент|очередь|десят|сотн|сейчас.{0,30}ищем|в вашем доме/i.test(sideQuestion.turns[0]?.reply ?? ""), "do not invent demand, client volume, or an active tenant search");
  });
  const lines = [
    "# Batymi dialogue quality check",
    "",
    `Provider: configured OpenAI-compatible endpoint; model: ${config.llmModel}. No credentials included.`,
    "This check called the configured language-model API and ran the local conversation guard. It did not call CRM, GreenAPI, or WhatsApp.",
    "",
  ];
  for (const result of results) {
    lines.push(`## ${result.name}`, "", `Final CRM status: ${result.listing.crm_status}; contact type: ${result.listing.contact_type ?? "unset"}.`, "");
    for (const [index, turn] of result.turns.entries()) {
      lines.push(
        `### Turn ${index + 1}`,
        "",
        `Owner: ${turn.user}`,
        `CRM status: ${turn.statusBefore} → ${turn.statusAfter}; contact type: ${turn.contactType}; stopped: ${turn.stopped}`,
        `Actions: ${JSON.stringify(turn.actions)}`,
        "",
        "Raw model output:",
        "```json",
        turn.raw,
        "```",
        "",
        "Final reply after local guard:",
        "```text",
        turn.reply,
        "```",
        "",
      );
    }
  }
  lines.push("## Assertions", "", failures.length ? failures.map((failure) => `- FAIL: ${failure}`).join("\n") : "All dialogue assertions passed.", "");

  const reportDir = join(process.cwd(), "reports");
  mkdirSync(reportDir, { recursive: true });
  const reportPath = join(reportDir, "dialogue-quality-check.md");
  writeFileSync(reportPath, `${lines.join("\n")}\n`, "utf8");
  console.log(`Dialogue report: ${reportPath}`);
  if (failures.length) {
    console.error(failures.join("\n"));
    process.exitCode = 1;
  } else {
    console.log("All dialogue assertions passed.");
  }
}

void main().catch((error) => {
  console.error(`Dialogue check failed: ${(error as Error).message}`);
  process.exitCode = 1;
});
