import { afterEach, describe, expect, it } from "vitest";
import { ownerDialogueCorpus, OwnerDialogueScenario, OwnerDialogueTurn } from "../conversations/owner-dialogue-corpus";
import { createOwnerDialogueRuntime, getPath, primaryListingSnapshot, runOwnerDialogueTurn, ScriptedOwnerDialogueLlm, writeSignature } from "../helpers/owner-dialogue-runner";

const openRuntimes: Array<{ close: () => Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(openRuntimes.splice(0).map((runtime) => runtime.close()));
});

function cases(): OwnerDialogueScenario[] {
  return ownerDialogueCorpus.flatMap((scenario) => [scenario, ...(scenario.alternates ?? [])]);
}

function checkTurn(turn: OwnerDialogueTurn, record: Awaited<ReturnType<typeof runOwnerDialogueTurn>>, listingId?: string | number): void {
  const expected = turn.expect;
  const state = record.after as { contact_type: string | null; listings: Array<Record<string, unknown>> };
  const listing = primaryListingSnapshot(record.after, expected.listingId ?? listingId);
  if (expected.status) expect(listing.crm_status, JSON.stringify({ outcome: record.outcome, writes: record.writeEvents })).toBe(expected.status);
  if (expected.contactType !== undefined) expect(state.contact_type, JSON.stringify({ outcome: record.outcome, writes: record.writeEvents })).toBe(expected.contactType);
  for (const [path, value] of Object.entries(expected.fields ?? {})) {
    expect(getPath(path.startsWith("rental_terms.") ? listing : listing, path)).toEqual(value);
  }
  for (const path of expected.absentFields ?? []) expect(getPath(listing, path) == null).toBe(true);
  if (expected.sendCount !== undefined) expect(record.totalSentAfter, JSON.stringify({ outcome: record.outcome, writes: record.writeEvents })).toBe(expected.sendCount);
  if (expected.writeCount !== undefined) expect(record.totalWritesAfter).toBe(expected.writeCount);
  if (expected.writeSignatures) {
    expect((record.writeEvents as Array<{ path: string; body: unknown }>).map(writeSignature)).toEqual(expected.writeSignatures);
  }
  if (expected.runStatus) expect(record.outcome.status).toBe(expected.runStatus);
  if (expected.stopConversation !== undefined) expect(record.outcome.stopConversation).toBe(expected.stopConversation);
  if (expected.runModel === false) expect(record.modelCallsAfter).toBe(record.modelCallsBefore);
  if (expected.runModel === true) expect(record.modelCallsAfter).toBeGreaterThan(record.modelCallsBefore);
  if (turn.duplicateWebhook) expect(record.duplicateAccepted).toBe(false);
  const reply = record.sentMessages.at(-1) as { message?: string } | undefined;
  for (const fragment of expected.replyIncludes ?? []) expect((reply?.message ?? record.outcome.reply ?? "").toLocaleLowerCase()).toContain(fragment.toLocaleLowerCase());
  const replyText = (reply?.message ?? record.outcome.reply ?? "").toLocaleLowerCase();
  for (const fragment of expected.replyExcludes ?? []) {
    if (fragment === "asks-price") expect(replyText).not.toMatch(/(?:какая|сколько|назовите|уточните).{0,35}(?:цен|стоим)|(?:what|how much).{0,25}(?:price|rent)/i);
    else if (fragment === "asks-minimum-term") expect(replyText).not.toMatch(/(?:какой|какова|уточните|назовите).{0,35}(?:минимальн|срок)|(?:what|how long).{0,25}(?:minimum|term|lease)/i);
    else expect(replyText).not.toContain(fragment.toLocaleLowerCase());
  }
  if (record.sentMessages.length > 0 && expected.runStatus !== "failed") {
    expect(record.sentMessages.at(-1)).toMatchObject({ instance_id: "acceptance-instance", phone: "+995599123456" });
  }
}

describe("owner dialogue acceptance through production conversation orchestration", () => {
  it.each(cases())("$id: $title", async (scenario) => {
    let provider: ScriptedOwnerDialogueLlm | undefined;
    const runtime = await createOwnerDialogueRuntime(scenario, (turns) => (provider = new ScriptedOwnerDialogueLlm(turns)));
    openRuntimes.push(runtime);
    for (const [index, turn] of scenario.turns.entries()) {
      const record = await runOwnerDialogueTurn(runtime, turn, index + 1);
      checkTurn(turn, record, scenario.listingIds?.[0]);
      if (turn.failCrmWrite) {
        expect(record.attempts).toHaveLength(2);
        expect(record.attempts[0].outcome.status).toBe("rescheduled");
        expect(record.attempts[0].sentCount).toBe(0);
        const failedState = record.attempts[0].after as { contact_type: string | null; listings: Array<Record<string, unknown>> };
        expect(failedState.contact_type).toBeNull();
        expect(primaryListingSnapshot(record.attempts[0].after).crm_status).toBe("sent");
        expect(getPath(primaryListingSnapshot(record.attempts[0].after), "rental_terms.price")).toBeNull();
        expect(record.attempts[1].outcome.status).toBe("processed");
      }
      if ((scenario.listingIds?.length ?? 0) > 1) {
        const other = primaryListingSnapshot(record.after, scenario.listingIds![1]);
        expect(other.rental_terms).toEqual(primaryListingSnapshot(record.before, scenario.listingIds![1]).rental_terms);
        const rentalWrites = record.writeEvents.filter((event) =>
          typeof (event as { path?: unknown }).path === "string" && String((event as { path: string }).path).includes("/rental-terms"),
        );
        expect(rentalWrites.every((event) => String((event as { path: string }).path).includes(`/listings/${scenario.listingIds![0]}/`))).toBe(true);
      }
      expect(record.runId).toMatch(/^[0-9a-f-]{36}$/i);
      expect(JSON.stringify(record)).not.toContain(runtime.crm.apiKey);
      if (turn.expect.runModel === false) continue;
      if (turn.expect.runStatus !== "failed" && turn.expect.runStatus !== "terminal" && turn.expect.runStatus !== "skipped") {
        expect(record.outcome.status).toBe("processed");
      }
      expect(provider?.calls.length).toBeGreaterThan(record.modelCallsBefore);
    }
  });
});
