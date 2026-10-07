import { describe, expect, it } from "vitest";
import { AgentAction } from "../../src/agent/schemas";
import { groundRentalFacts } from "../../src/conversation/rental-facts";

describe("rental action validation", () => {
  it("preserves a model-proposed future availability note and unknown status", () => {
    const proposed: AgentAction[] = [{
      type: "update_rental_terms",
      listingId: 101,
      data: { lease_terms_notes: "Свободна с декабря", availability_status: "unknown" },
    }];

    const grounded = groundRentalFacts({
      currentMessage: "Свободна с декабря",
      proposedActions: proposed,
      primaryListingId: 101,
    });

    expect(grounded).toEqual(proposed);
    expect(grounded[0].type === "update_rental_terms" && grounded[0].data).toEqual({
      lease_terms_notes: "Свободна с декабря",
      availability_status: "unknown",
    });
  });

  it("does not infer CRM writes from message text or earlier history", () => {
    expect(groundRentalFacts({
      currentMessage: "Вид на море, минимальный срок 6 месяцев, цена 900 в месяц",
      history: [{ role: "assistant", content: "Квартира ещё сдаётся?" }],
      proposedActions: [],
    })).toEqual([]);
  });

  it("keeps only the current model-proposed correction without replaying older CRM facts", () => {
    const correction: AgentAction[] = [{
      type: "update_rental_terms",
      data: { minimum_lease_months: 6 },
    }];
    const grounded = groundRentalFacts({
      currentMessage: "Нет, теперь минимум 6 месяцев",
      history: [{ role: "user", content: "Раньше минимум 12 месяцев" }],
      proposedActions: correction,
    });

    expect(grounded).toEqual(correction);
    expect(grounded.some(action => action.type === "update_rental_terms" && action.data.minimum_lease_months === 12)).toBe(false);
  });
});
