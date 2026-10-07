import { AgentAction, actionSchema } from "../agent/schemas";
export interface RentalFactMessage { role: string; content: string }
export interface GroundRentalFactsInput {
  currentMessage: string; lastAssistantQuestion?: string; history?: RentalFactMessage[];
  proposedActions: AgentAction[]; primaryListingId?: string | number | null;
}
/** Compatibility for local callers: validate shape, never infer or rewrite facts. */
export function groundRentalFacts(input: GroundRentalFactsInput): AgentAction[] {
  return input.proposedActions.map(action => actionSchema.parse(action));
}
