import { describe, expect, it } from "vitest"
import { Array as Arr } from "effect"
import { profileSummary } from "./profile-flamegraph-view"

const MS = 1_000_000
const cpu = {
	sampleType: "cpu",
	sampleUnit: "nanoseconds",
	totalValue: 9000 * MS,
	totalStacks: 2,
	durationNano: 60_000 * MS,
	stacks: Arr.makeBy(2, () => ({})),
}

describe("profileSummary", () => {
	it("reads CPU time as time on CPU and average cores", () => {
		expect(profileSummary(cpu)).toBe("9.00s on CPU, 0.15 cores on average, 2 distinct stacks")
	})

	it("says when a capped read left the lighter stacks out", () => {
		expect(profileSummary({ ...cpu, totalStacks: 2400 })).toBe(
			"9.00s on CPU, 0.15 cores on average, heaviest 2 of 2.4K distinct stacks",
		)
	})

	it("gives no cores without a profiled duration, and no CPU wording for other types", () => {
		expect(profileSummary({ ...cpu, durationNano: 0 })).toBe("9.00s on CPU, 2 distinct stacks")
		expect(
			profileSummary({ ...cpu, sampleType: "alloc_space", sampleUnit: "bytes", totalValue: 2048 }),
		).toMatch(/, 2 distinct stacks$/)
	})
})
