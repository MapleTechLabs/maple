import { describe, expect, test } from "vitest"
import {
	delayFor,
	isExhausted,
	postponed,
	probed,
	RESUME_WINDOW_MS,
	resume,
	type RetryBudget,
} from "./auto-retry-budget"

const MID = 0.5

/** Every timed probe of one outage, remounting after each like a retry that fails again. */
const outage = (start: number): ReadonlyArray<number> => {
	const step = (budget: RetryBudget, fired: ReadonlyArray<number>): ReadonlyArray<number> =>
		isExhausted(budget)
			? fired
			: step(resume(probed(budget, budget.nextAt, MID), budget.nextAt + 50, MID), [
					...fired,
					budget.nextAt,
				])
	return step(resume(undefined, start, MID), [])
}

describe("auto-retry budget", () => {
	test("a remount after each failed retry still backs off and stops", () => {
		const fired = outage(0)
		const gaps = fired.map((at, index) => at - (fired[index - 1] ?? 0))
		expect(gaps).toEqual([5_000, 10_000, 20_000, 30_000, 30_000, 30_000])
	})

	test("a hidden tab waits another step without spending an attempt", () => {
		const budget = resume(undefined, 0, MID)
		const waited = postponed(budget, budget.nextAt, MID)
		expect(waited.attempt).toBe(0)
		expect(waited.nextAt).toBe(budget.nextAt + 5_000)
	})

	test("a failure after a quiet spell starts a fresh budget", () => {
		const spent = probed(probed(resume(undefined, 0, MID), 5_000, MID), 15_000, MID)
		expect(resume(spent, 15_000 + RESUME_WINDOW_MS - 1, MID).attempt).toBe(2)
		expect(resume(spent, 15_000 + RESUME_WINDOW_MS, MID).attempt).toBe(0)
	})

	test("manual retries after the last probe do not keep a spent budget alive", () => {
		const spent = Array.from({ length: 6 }).reduce<RetryBudget>(
			(budget) => probed(budget, budget.nextAt, MID),
			resume(undefined, 0, MID),
		)
		const lastProbe = spent.touchedAt
		const remounted = [10_000, 30_000, 50_000].reduce(
			(budget, offset) => resume(budget, lastProbe + offset, MID),
			spent,
		)
		expect(isExhausted(remounted)).toBe(true)
		expect(isExhausted(resume(remounted, lastProbe + RESUME_WINDOW_MS, MID))).toBe(false)
	})

	test("jitter stays within ten percent of the step", () => {
		expect(delayFor(1, 0)).toBe(9_000)
		expect(delayFor(1, 0.999)).toBeLessThan(11_000)
	})
})
