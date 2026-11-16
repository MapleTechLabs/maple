import { describe, expect, it } from "vitest"
import { SecurityAuditTarget } from "@maple/domain/http"
import { Schema } from "effect"
import { prCheckRuleOf, runTotalUsd } from "./format"

describe("runTotalUsd", () => {
	it("counts a live run's sandbox fees before its model cost settles", () => {
		expect([
			runTotalUsd({ costUsd: null, sandboxUsd: 0.18 }),
			runTotalUsd({ costUsd: 2.5, sandboxUsd: 0.5 }),
			runTotalUsd({ costUsd: null, sandboxUsd: 0 }),
		]).toEqual([0.18, 3, null])
	})
})

const targetWith = (prCheckEnabled: boolean, prCheckBlockAt: "high" | null) =>
	Schema.decodeSync(SecurityAuditTarget)({
		id: "6f0c8a52-1b0e-4c5e-9f36-1f7f3f1b2a90",
		repository: "acme/api",
		branch: "main",
		enabled: true,
		profile: "deep",
		scopePaths: [],
		discoveryModel: null,
		validationModel: null,
		prCheckEnabled,
		prCheckBlockAt,
		createdBy: "user_1",
		createdAt: 0,
		updatedAt: 0,
	})

describe("prCheckRuleOf", () => {
	it("states the current rule, and that the check is off when it is", () => {
		expect(prCheckRuleOf(targetWith(true, "high"))).toBe("Current rule: fails at high and above")
		expect(prCheckRuleOf(targetWith(true, null))).toBe("Current rule: reports only, never blocks")
		expect(prCheckRuleOf(targetWith(false, "high"))).toBe("Current rule: the pull request check is off")
	})
})
