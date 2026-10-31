// The error state's auto-retry backoff, outside any one Mount. A retry swaps the failure for
// `Loading`, which unmounts the error state, so a counter inside the Mount restarted at the
// first delay on every failure and never reached the cap.

const POLL_DELAYS_MS = [5_000, 10_000, 20_000, 30_000]
export const MAX_POLL_ATTEMPTS = 6
/** A budget untouched this long belongs to an earlier outage: the next failure starts over. */
export const RESUME_WINDOW_MS = 60_000

export type RetryBudget = Readonly<{
	attempt: number
	/** When the next timed probe is due; a probe before it is another mount sharing the budget. */
	nextAt: number
	touchedAt: number
}>

/** `jitter` is in [0, 1): the delay lands within ±10% of the step. */
export const delayFor = (attempt: number, jitter: number): number =>
	(POLL_DELAYS_MS[Math.min(attempt, POLL_DELAYS_MS.length - 1)] ?? 30_000) * (0.9 + jitter * 0.2)

/** The budget a new mount continues, or a fresh one when the last outage went quiet. A mount does
 * not touch it: a manual retry after the last probe must not keep a spent budget alive. */
export const resume = (prior: RetryBudget | undefined, now: number, jitter: number): RetryBudget =>
	prior !== undefined && now - prior.touchedAt < RESUME_WINDOW_MS
		? prior
		: { attempt: 0, nextAt: now + delayFor(0, jitter), touchedAt: now }

/** A timed probe fired: count it and back off. */
export const probed = (budget: RetryBudget, now: number, jitter: number): RetryBudget => ({
	attempt: budget.attempt + 1,
	nextAt: now + delayFor(budget.attempt + 1, jitter),
	touchedAt: now,
})

/** Hidden or offline when due: wait another step without counting it. */
export const postponed = (budget: RetryBudget, now: number, jitter: number): RetryBudget => ({
	...budget,
	nextAt: now + delayFor(budget.attempt, jitter),
	touchedAt: now,
})

export const isExhausted = (budget: RetryBudget): boolean => budget.attempt >= MAX_POLL_ATTEMPTS
