import { AgentAction } from "../../src/agent/schemas";
import { Listing, RentalTerms } from "../../src/types";
import { baseListing, ConversationScenario, ExpectedAction, ScenarioCRMState } from "./scenarios";

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

  return failures;
}
