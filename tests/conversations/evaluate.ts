import { AgentAction } from "../../src/agent/schemas";
import { Listing, RentalTerms } from "../../src/types";
import { baseListing, ConversationScenario, ExpectedAction, ExpectedTurn, ExpectedTransitionReply, ScenarioCRMState } from "./scenarios";

export interface EvaluatedTurn {
  crmStatusBefore: string;
  crmStatusAfter: string;
  crmStateAfter?: ScenarioCRMState;
  actions: AgentAction[];
  reply: string;
  stopped: boolean;
}

export function buildListing(state: ScenarioCRMState): Listing {
  const { rentalTerms, ...rest } = state;
  const listing: Listing = { ...structuredClone(baseListing), ...rest };
  if (rentalTerms) {
    listing.rental_terms = { ...(listing.rental_terms ?? {}), ...rentalTerms } as RentalTerms;
  }
  return listing;
}

export function applyActions(listing: Listing, actions: AgentAction[]): void {
  for (const action of actions) {
    if (action.type === "set_contact_type") listing.contact_type = action.contactType;
    if (action.type === "set_crm_status") listing.crm_status = action.status;
    if (action.type === "update_deal_info") {
      for (const [key, value] of Object.entries(action.data)) {
        if (typeof value === "string" && value.trim() === "") continue;
        (listing as unknown as Record<string, unknown>)[key] = value;
      }
    }
    if (action.type === "update_rental_terms") {
      listing.rental_terms = {
        ...(listing.rental_terms ?? {}),
        ...action.data,
      } as RentalTerms;
    }
  }
}

export function actionMatches(actual: AgentAction, expected: ExpectedAction): boolean {
  if (actual.type !== expected.type) return false;
  if (expected.contactType && (actual as { contactType?: string }).contactType !== expected.contactType) {
    return false;
  }
  if (expected.status && (actual as { status?: string }).status !== expected.status) return false;
  if (expected.data) {
    const data = (actual as { data?: Record<string, unknown> }).data ?? {};
    for (const [key, value] of Object.entries(expected.data)) {
      if (data[key] !== value) return false;
    }
  }
  return true;
}

export function forbiddenHit(actions: AgentAction[], forbidden: string): boolean {
  const [type, value] = forbidden.split(":");
  return actions.some((action) => {
    if (action.type !== type) return false;
    if (!value) return true;
    if (action.type === "set_contact_type") return action.contactType === value;
    if (action.type === "set_crm_status") return action.status === value;
    return false;
  });
}

export function evaluate(
  scenario: ConversationScenario,
  actions: AgentAction[],
  listing: Listing,
  stopped: boolean,
  turns: EvaluatedTurn[] = [],
): string[] {
  const failures: string[] = [];

  for (const expected of scenario.expectedActions) {
    if (!actions.some((action) => actionMatches(action, expected))) {
      failures.push(`missing action ${JSON.stringify(expected)}`);
    }
  }

  for (const forbidden of scenario.forbiddenActions) {
    if (forbiddenHit(actions, forbidden)) failures.push(`forbidden action ${forbidden}`);
  }

  for (const [type, keys] of Object.entries(scenario.forbiddenDataKeys ?? {})) {
    for (const action of actions) {
      if (action.type !== type) continue;
      const data = (action as { data?: Record<string, unknown> }).data ?? {};
      for (const key of keys) {
        if (key in data) failures.push(`forbidden data key ${type}.${key} (собственник этого не называл)`);
      }
    }
  }

  for (const [index, expected] of (scenario.expectedTurns ?? []).entries()) {
    const turn = turns[index];
    if (!turn) {
      failures.push(`missing evaluated turn ${index + 1}`);
      continue;
    }
    checkExpectedTurn(expected, turn, index, failures);
    for (const forbidden of expected.forbiddenActions ?? []) {
      if (forbiddenHit(turn.actions, forbidden)) failures.push(`turn ${index + 1} forbidden action ${forbidden}`);
    }
  }
  for (const expected of scenario.transitionReplies ?? []) {
    const transition = turns.find((turn) =>
      turn.crmStatusBefore === expected.fromStatus && turn.crmStatusAfter === expected.toStatus,
    );
    if (!transition) {
      failures.push(`missing CRM transition ${expected.fromStatus} -> ${expected.toStatus}`);
      continue;
    }
    if (!transition.actions.some((action) => action.type === "set_crm_status" && action.status === expected.toStatus)) {
      failures.push(`missing set_crm_status:${expected.toStatus} action on ${expected.fromStatus} -> ${expected.toStatus} transition`);
    }
    checkTransitionReply(expected, transition, failures);
  }

  if (scenario.expectedFinalCRMState) {
    const { rentalTerms, ...rest } = scenario.expectedFinalCRMState;
    for (const [key, value] of Object.entries(rest)) {
      const actual = (listing as unknown as Record<string, unknown>)[key];
      if (String(actual ?? "") !== String(value ?? "")) {
        failures.push(`final CRM ${key}=${String(actual)} expected ${String(value)}`);
      }
    }
    for (const [key, value] of Object.entries(rentalTerms ?? {})) {
      const actual = (listing.rental_terms as unknown as Record<string, unknown>)?.[key];
      if (String(actual ?? "") !== String(value ?? "")) {
        failures.push(`final rental ${key}=${String(actual)} expected ${String(value)}`);
      }
    }
  }

  if (scenario.stopConversation === true && !stopped) failures.push("expected stopConversation=true");

  // Проверки ответа собственнику: диалог не должен обрываться подтверждением.
  const lastReply = (turns.map((turn) => turn.reply).filter((reply) => reply && reply.trim().length > 0).at(-1) ?? "").trim();
  for (const needle of scenario.finalReplyMustContain ?? []) {
    if (!lastReply.toLowerCase().includes(needle.toLowerCase())) {
      failures.push(`final reply missing "${needle}" (ответ собственнику: ${lastReply.slice(0, 120) || "<пусто>"})`);
    }
  }
  if (!scenario.noQuestionOk) {
    turns.forEach((turn, index) => {
      if (turn.stopped) return;
      const reply = turn.reply.trim();
      if (!reply) {
        failures.push(`turn ${index + 1} has no reply although the conversation continues`);
      } else if (!/[?？](?:\s*[😊🙂😉👍🙏]*)$/.test(reply)) {
        failures.push(`turn ${index + 1} reply must end with a question while the conversation continues: ${replySnippet(reply)}`);
      }
    });
  }

  return failures;
}

function replySnippet(reply: string): string {
  if (reply.length <= 180) return reply;
  return `${reply.slice(0, 80)} … ${reply.slice(-80)}`;
}

function checkExpectedTurn(expected: ExpectedTurn, turn: EvaluatedTurn, index: number, failures: string[]): void {
  if (expected.crmStatusBefore && turn.crmStatusBefore !== expected.crmStatusBefore) {
    failures.push(`turn ${index + 1} started with CRM status ${turn.crmStatusBefore}, expected ${expected.crmStatusBefore}`);
  }
  if (expected.crmStatusAfter && turn.crmStatusAfter !== expected.crmStatusAfter) {
    failures.push(`turn ${index + 1} ended with CRM status ${turn.crmStatusAfter}, expected ${expected.crmStatusAfter}`);
  }
  if (!turn.reply.trim()) failures.push(`turn ${index + 1} has no reply`);
  for (const needle of expected.replyMustContain ?? []) {
    if (!turn.reply.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) {
      failures.push(`turn ${index + 1} reply missing "${needle}" (ответ: ${turn.reply.slice(0, 120) || "<пусто>"})`);
    }
  }
  for (const action of expected.requiredActions ?? []) {
    if (!turn.actions.some((actual) => actionMatches(actual, action))) {
      failures.push(`turn ${index + 1} missing action ${JSON.stringify(action)}`);
    }
  }
  if (expected.expectedCRMState) {
    if (!turn.crmStateAfter) {
      failures.push(`turn ${index + 1} missing CRM state snapshot`);
      return;
    }
    const { rentalTerms, ...fields } = expected.expectedCRMState;
    for (const [key, value] of Object.entries(fields)) {
      const actual = (turn.crmStateAfter as Record<string, unknown>)[key];
      if (String(actual ?? "") !== String(value ?? "")) {
        failures.push(`turn ${index + 1} CRM ${key}=${String(actual)} expected ${String(value)}`);
      }
    }
    for (const [key, value] of Object.entries(rentalTerms ?? {})) {
      const actual = (turn.crmStateAfter.rentalTerms as Record<string, unknown> | undefined)?.[key];
      if (String(actual ?? "") !== String(value ?? "")) {
        failures.push(`turn ${index + 1} rental ${key}=${String(actual)} expected ${String(value)}`);
      }
    }
  }
}

function checkTransitionReply(expected: ExpectedTransitionReply, turn: EvaluatedTurn, failures: string[]): void {
  for (const needle of expected.replyMustContain) {
    if (!turn.reply.toLocaleLowerCase().includes(needle.toLocaleLowerCase())) {
      failures.push(`reply on ${expected.fromStatus} -> ${expected.toStatus} transition missing "${needle}"`);
    }
  }
}
