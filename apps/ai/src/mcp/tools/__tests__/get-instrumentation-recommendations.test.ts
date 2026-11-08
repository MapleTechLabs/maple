// Pure-helper tests for the get_instrumentation_recommendations MCP tool.
// Detection/reconcile logic is covered by packages/domain/src/recommendations.test.ts;
// here we only guard the tool's severity mapping and coverage-gap derivation.

import { describe, expect, it } from "vitest"
import { deriveCoverageGaps } from "../get-instrumentation-recommendations"
import { Array as Arr } from "effect"

describe("deriveCoverageGaps", () => {
	const keys = (...names: string[]) => Arr.map(names, (key) => ({ key }))

	it("reports every gap when nothing recommended arrives", () => {
		const gaps = deriveCoverageGaps(keys("service.name", "host.name"))
		expect(Arr.map(gaps, (gap) => gap.checkId).sort()).toEqual(["RES-02", "RES-03", "RES-04", "RES-05"])
		expect(Arr.every(gaps, (gap) => gap.severity === "warn")).toBe(true)
	})

	it("reports no gaps when all recommended attributes arrive", () => {
		const gaps = deriveCoverageGaps(
			keys(
				"service.version",
				"deployment.environment",
				"vcs.repository.url.full",
				"vcs.ref.head.revision",
			),
		)
		expect(gaps).toEqual([])
	})

	it("accepts either spelling of the deployment environment key", () => {
		const legacy = deriveCoverageGaps(keys("deployment.environment"))
		const current = deriveCoverageGaps(keys("deployment.environment.name"))
		expect(Arr.some(legacy, (gap) => gap.checkId === "RES-03")).toBe(false)
		expect(Arr.some(current, (gap) => gap.checkId === "RES-03")).toBe(false)
	})

	it("flags a missing VCS revision independently of the repo URL", () => {
		const gaps = deriveCoverageGaps(
			keys("service.version", "deployment.environment.name", "vcs.repository.url.full"),
		)
		expect(Arr.map(gaps, (gap) => gap.checkId)).toEqual(["RES-05"])
		expect(Arr.getUnsafe(gaps, 0).attribute).toBe("vcs.ref.head.revision")
	})
})
