import { Record as Rec } from "effect"
import { describe, expect, it } from "vitest"
import { plannedUnit } from "../__fixtures__/records"
import { criticLedger } from "./hunt"

describe("criticLedger", () => {
	it("leaves a new unit's empty and default fields out", () => {
		const [unit] = criticLedger([plannedUnit])
		expect(Rec.keys(unit ?? {}).sort()).toEqual(
			[
				"id",
				"status",
				"canonical_refs",
				"surface",
				"boundary",
				"subsystem",
				"attack_class",
				"starting_paths",
				"ordinary_attack_class_block",
				"selected_companion_blocks",
				"excluded_blocks",
			].sort(),
		)
	})

	it("keeps the evidence a covered unit carries and drops its owner and check prose", () => {
		const [unit] = criticLedger([
			{
				...plannedUnit,
				status: "candidate",
				agent_id: "hunter-w1-1",
				priority: 2,
				wave: 2,
				reviewed_paths: ["src/routes/keys.ts"],
				local_checks: [
					{
						agent_id: "hunter-w1-1",
						reviewed_paths: ["src/routes/keys.ts"],
						invariant: "roll is scoped to the caller's org",
						method: "source",
						result: "a long account of what the source showed",
						artifact: null,
					},
				],
				result_fingerprints: ["keys/roll-missing-org-scope"],
				not_rechecked: ["keys/roll-missing-org-scope"],
			},
		])
		expect(unit).toMatchObject({
			wave: 2,
			reviewed_paths: ["src/routes/keys.ts"],
			checks: ["roll is scoped to the caller's org"],
			result_fingerprints: ["keys/roll-missing-org-scope"],
			not_rechecked: ["keys/roll-missing-org-scope"],
		})
		expect(unit).not.toHaveProperty("agent_id")
		expect(unit).not.toHaveProperty("priority")
		expect(unit).not.toHaveProperty("coverage_id")
	})
})
