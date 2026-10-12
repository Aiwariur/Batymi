import { readdirSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { waApiWebhookSchema } from "../../src/waapi/waapi.schemas";

const fixturesDir = resolve(process.cwd(), "tests/fixtures/waapi");
const fixtures = readdirSync(fixturesDir).filter(name => name.endsWith(".json")).sort();

describe("CRM reference WaAPI fixtures", () => {
  it("accepts every shared CRM stage-4 fixture envelope", () => {
    expect(fixtures.length).toBeGreaterThan(0);
    for (const name of fixtures) {
      const payload: unknown = JSON.parse(readFileSync(resolve(fixturesDir, name), "utf8"));
      const parsed = waApiWebhookSchema.safeParse(payload);
      expect(parsed.success, `${name}: ${parsed.success ? "" : parsed.error.issues.map(issue => issue.path.join(".")).join(", ")}`)
        .toBe(true);
    }
  });
});
