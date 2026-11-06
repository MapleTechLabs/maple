import { describe, expect, it } from "vitest"
import { comparePaired, passAt1, passAtK, passHatK } from "./stats"

describe("eval statistics", () => {
	it("averages per-task pass rates, not pooled trials", () => {
		// Pooled, this is 11/13; per task it is (10/10 + 1/3) / 2.
		const result = passAt1([
			{ task: "a", trials: 10, passes: 10 },
			{ task: "b", trials: 3, passes: 1 },
		])
		expect(result.mean).toBeCloseTo(2 / 3)
		expect(result.se).toBeGreaterThan(0)
	})

	it("has no spread to report for a single task", () => {
		expect(passAt1([{ task: "a", trials: 5, passes: 2 }]).se).toBe(0)
	})

	it("reads pass^k as all k trials passing and pass@k as any", () => {
		// 3 of 4 pass: pass^2 = C(3,2)/C(4,2) = 0.5; pass@2 = 1 − C(1,2)/C(4,2) = 1.
		const tallies = [{ task: "a", trials: 4, passes: 3 }]
		expect(passHatK(tallies, 2)).toBeCloseTo(0.5)
		expect(passAtK(tallies, 2)).toBe(1)
		expect(passHatK(tallies, 1)).toBeCloseTo(0.75)
	})

	it("skips tasks with fewer trials than k", () => {
		expect(passHatK([{ task: "a", trials: 1, passes: 1 }], 3)).toBeNaN()
	})

	it("compares only the tasks both runs share, as paired differences", () => {
		const result = comparePaired(
			[
				{ task: "a", trials: 2, passes: 2 },
				{ task: "b", trials: 2, passes: 0 },
				{ task: "only-a", trials: 2, passes: 2 },
			],
			[
				{ task: "a", trials: 2, passes: 1 },
				{ task: "b", trials: 2, passes: 0 },
			],
		)
		expect(result.tasks).toBe(2)
		expect(result.delta).toBeCloseTo(0.25)
		expect(result.aBetter).toEqual(["a"])
		expect(result.bBetter).toEqual([])
	})
})
