/**
 * Eval statistics, after Anthropic's "A statistical approach to model evals" and tau-bench.
 *
 * Trials of one task are not independent samples, so the unit is the task: pass@1 is the mean of
 * per-task pass rates and its standard error is taken over those means (clustered by task). Two
 * runs are compared on the tasks they share, as paired per-task differences.
 */

export interface TaskTally {
	readonly task: string
	readonly trials: number
	readonly passes: number
}

/** Binomial coefficient as a float; exact enough for the k ≤ 20 an eval uses. */
const choose = (n: number, k: number): number => {
	if (k < 0 || k > n) return 0
	let result = 1
	for (let i = 1; i <= k; i++) result = (result * (n - k + i)) / i
	return result
}

const mean = (values: ReadonlyArray<number>): number =>
	values.length === 0 ? Number.NaN : values.reduce((sum, value) => sum + value, 0) / values.length

/** Standard error of the mean; zero when there is one value, since there is no spread to measure. */
const standardError = (values: ReadonlyArray<number>): number => {
	if (values.length < 2) return 0
	const m = mean(values)
	const variance = values.reduce((sum, value) => sum + (value - m) ** 2, 0) / (values.length - 1)
	return Math.sqrt(variance / values.length)
}

export interface Estimate {
	readonly mean: number
	readonly se: number
	/** 95% interval, clipped to [0, 1]. */
	readonly low: number
	readonly high: number
}

const estimate = (values: ReadonlyArray<number>): Estimate => {
	const m = mean(values)
	const se = standardError(values)
	return { mean: m, se, low: Math.max(0, m - 1.96 * se), high: Math.min(1, m + 1.96 * se) }
}

export const passAt1 = (tallies: ReadonlyArray<TaskTally>): Estimate =>
	estimate(tallies.filter((tally) => tally.trials > 0).map((tally) => tally.passes / tally.trials))

/** Chance at least one of k trials passes (unbiased, from n ≥ k trials). */
export const passAtK = (tallies: ReadonlyArray<TaskTally>, k: number): number =>
	mean(
		tallies
			.filter((tally) => tally.trials >= k)
			.map((tally) => 1 - choose(tally.trials - tally.passes, k) / choose(tally.trials, k)),
	)

/** Chance all of k trials pass: tau-bench's consistency measure (unbiased, from n ≥ k trials). */
export const passHatK = (tallies: ReadonlyArray<TaskTally>, k: number): number =>
	mean(
		tallies
			.filter((tally) => tally.trials >= k)
			.map((tally) => choose(tally.passes, k) / choose(tally.trials, k)),
	)

export interface PairedComparison {
	readonly tasks: number
	/** Mean of (A − B) per-task pass rates, with its 95% interval. */
	readonly delta: number
	readonly se: number
	readonly low: number
	readonly high: number
	readonly aBetter: ReadonlyArray<string>
	readonly bBetter: ReadonlyArray<string>
}

export const comparePaired = (a: ReadonlyArray<TaskTally>, b: ReadonlyArray<TaskTally>): PairedComparison => {
	const rateOf = (tally: TaskTally) => tally.passes / tally.trials
	const bByTask = new Map(b.filter((tally) => tally.trials > 0).map((tally) => [tally.task, rateOf(tally)]))
	const pairs = a.flatMap((tally) => {
		const other = bByTask.get(tally.task)
		return tally.trials > 0 && other !== undefined
			? [{ task: tally.task, diff: rateOf(tally) - other }]
			: []
	})
	const diffs = pairs.map((pair) => pair.diff)
	const delta = mean(diffs)
	const se = standardError(diffs)
	return {
		tasks: pairs.length,
		delta,
		se,
		low: delta - 1.96 * se,
		high: delta + 1.96 * se,
		aBetter: pairs.filter((pair) => pair.diff > 0).map((pair) => pair.task),
		bBetter: pairs.filter((pair) => pair.diff < 0).map((pair) => pair.task),
	}
}
