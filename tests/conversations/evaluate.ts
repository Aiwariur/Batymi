import { AgentAction, emptyDealInfo } from "../../src/agent/schemas";
import { Flat } from "../../src/types";
import { ConversationScenario, ExpectedAction } from "./scenarios";

export function applyActions(flat: Flat, actions: AgentAction[]): void {
  for (const action of actions) {
    if (action.type === "set_contact_type") flat.contact_type = action.contactType;
    if (action.type === "set_crm_status") flat.crm_status = action.status;
    if (action.type === "update_deal_info") {
      const data = { ...emptyDealInfo(), ...action.data };
      for (const [key, value] of Object.entries(data)) {
        if (value !== "") (flat as unknown as Record<string, unknown>)[key] = value;
      }
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
    const data = (actual as { data?: Record<string, string> }).data ?? {};
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
  flat: Flat,
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
    for (const [key, value] of Object.entries(scenario.expectedFinalCRMState)) {
      const actual = (flat as unknown as Record<string, unknown>)[key];
      if (String(actual ?? "") !== String(value ?? "")) {
        failures.push(`final CRM ${key}=${String(actual)} expected ${String(value)}`);
      }
    }
  }

  if (scenario.stopConversation === true && !stopped) failures.push("expected stopConversation=true");

  return failures;
}
