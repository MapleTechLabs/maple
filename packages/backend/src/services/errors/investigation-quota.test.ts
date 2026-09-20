import { describe, expect, it } from "vitest"
import type { IssueSeverity } from "@maple/domain/http"
import {
	DEFAULT_MAX_PASSES_PER_DAY,
	DEFAULT_MAX_RUNS_PER_DAY,
	effectiveLimit,
	evaluateInvestigationQuota,
	RESERVED_PASS_FRACTION,
	startOfUtcDay,
} from "./investigation-quota"

const NOW = Date.UTC(2026, 7, 9, 13, 30)
const MIDNIGHT_TOMORROW = Date.UTC(2026, 7, 10)

/** The pass ceiling an unclassified or low-severity start is judged against. */
const ORDINARY_LIMIT = Math.floor(DEFAULT_MAX_PASSES_PER_DAY * (1 - RESERVED_PASS_FRACTION))
/** The same, in runs. */
const ORDINARY_RUNS = Math.floor(DEFAULT_MAX_RUNS_PER_DAY * (1 - RESERVED_PASS_FRACTION))

const verdict = (input: {
	runs: number
	passes: number
	passCount: number
	severity?: IssueSeverity | null
	limits?: { maxRunsPerDay?: number | null; maxPassesPerDay?: number | null }
}) =>
	evaluateInvestigationQuota({
		usage: { runs: input.runs, passes: input.passes },
		limits: input.limits,
		passCount: input.passCount,
		nowMs: NOW,
		severity: input.severity,
	})

describe("evaluateInvestigationQuota", () => {
	it("allows a start below both ceilings", () => {
		expect(verdict({ runs: 1, passes: 6, passCount: 6 })).toEqual({ kind: "allowed" })
	})

	/**
	 * The reported dimension is what tells an operator which number to raise. A
	 * run cap raised to 100 looks ignored when it was the pass cap that stopped
	 * the start, so the two cases must stay distinguishable.
	 */
	it("names the runs ceiling when runs are spent", () => {
		expect(
			verdict({ runs: DEFAULT_MAX_RUNS_PER_DAY, passes: 0, passCount: 1, severity: "critical" }),
		).toEqual({
			kind: "exceeded",
			dimension: "runs",
			limit: DEFAULT_MAX_RUNS_PER_DAY,
			retryableAtMs: MIDNIGHT_TOMORROW,
		})
	})

	it("names the passes ceiling when a raised run cap leaves passes short", () => {
		expect(
			verdict({
				runs: 15,
				passes: DEFAULT_MAX_PASSES_PER_DAY - 2,
				passCount: 6,
				severity: "critical",
				limits: { maxRunsPerDay: 1000 },
			}),
		).toEqual({
			kind: "exceeded",
			dimension: "passes",
			limit: DEFAULT_MAX_PASSES_PER_DAY,
			retryableAtMs: MIDNIGHT_TOMORROW,
		})
	})

	/** Passes are checked as `used + requested`; runs as `used`, so the last slot stays usable. */
	it("lets the last run slot be used", () => {
		expect(
			verdict({ runs: DEFAULT_MAX_RUNS_PER_DAY - 1, passes: 0, passCount: 1, severity: "critical" }),
		).toEqual({ kind: "allowed" })
	})

	it("resets at the next UTC midnight regardless of the time of day", () => {
		expect(startOfUtcDay(NOW) + 24 * 60 * 60 * 1000).toBe(MIDNIGHT_TOMORROW)
	})

	describe("the severity reserve", () => {
		/**
		 * The regression this whole reserve exists for: overnight noise spent the
		 * budget first-come-first-served, so a daytime `critical` was refused by
		 * incidents that were never worth investigating.
		 */
		it("refuses a low-severity start once it would eat the reserve", () => {
			expect(verdict({ runs: 1, passes: ORDINARY_LIMIT - 1, passCount: 4, severity: "low" })).toEqual({
				kind: "exceeded",
				dimension: "passes_reserved",
				limit: ORDINARY_LIMIT,
				retryableAtMs: MIDNIGHT_TOMORROW,
			})
		})

		it("admits a critical start from the same reserve", () => {
			expect(
				verdict({ runs: 1, passes: ORDINARY_LIMIT - 1, passCount: 7, severity: "critical" }),
			).toEqual({ kind: "allowed" })
		})

		it("admits high as well as critical", () => {
			expect(verdict({ runs: 1, passes: ORDINARY_LIMIT + 50, passCount: 6, severity: "high" })).toEqual(
				{ kind: "allowed" },
			)
		})

		/**
		 * The reserve is worth nothing if anything unclassified can reach it, and
		 * an incident with no severity is far more often noise than an outage.
		 */
		it("treats an unknown severity as ordinary, not as priority", () => {
			for (const severity of [undefined, null] as const) {
				expect(
					verdict({ runs: 1, passes: ORDINARY_LIMIT - 1, passCount: 4, severity }),
				).toMatchObject({ kind: "exceeded", dimension: "passes_reserved" })
			}
		})

		it("lets an ordinary start use the last slot below the reserve", () => {
			expect(
				verdict({ runs: 1, passes: ORDINARY_LIMIT - 4, passCount: 4, severity: "medium" }),
			).toEqual({ kind: "allowed" })
		})

		/** A start judged against 700 must not report "limit 1000" — that sends the reader to the wrong number. */
		it("reports the ceiling that actually applied", () => {
			expect(effectiveLimit(1000, "low")).toBe(700)
			expect(effectiveLimit(1000, "critical")).toBe(1000)
		})

		/**
		 * The reserve used to guard passes only, which made it unreachable for any
		 * org that configured a run ceiling at all: runs are tested first, and a
		 * configured run ceiling is always the smaller number. Measured on the
		 * internal org 2026-09-17..19: 100 runs against a 700-pass effective
		 * ceiling, every refusal `dimension: "runs"`, the day's budget spent
		 * overnight on `medium` anomalies.
		 */
		it("refuses an ordinary start once it would eat the run reserve", () => {
			expect(verdict({ runs: ORDINARY_RUNS, passes: 0, passCount: 1, severity: "medium" })).toEqual({
				kind: "exceeded",
				dimension: "runs_reserved",
				limit: ORDINARY_RUNS,
				retryableAtMs: MIDNIGHT_TOMORROW,
			})
		})

		it("admits a critical start from the run reserve the same noise was refused from", () => {
			expect(verdict({ runs: ORDINARY_RUNS, passes: 0, passCount: 1, severity: "critical" })).toEqual({
				kind: "allowed",
			})
		})

		it("treats an unknown severity as ordinary against the run ceiling too", () => {
			for (const severity of [undefined, null] as const) {
				expect(verdict({ runs: ORDINARY_RUNS, passes: 0, passCount: 1, severity })).toMatchObject({
					kind: "exceeded",
					dimension: "runs_reserved",
				})
			}
		})

		it("still names the plain runs ceiling for a priority start", () => {
			expect(
				verdict({ runs: DEFAULT_MAX_RUNS_PER_DAY, passes: 0, passCount: 1, severity: "critical" }),
			).toMatchObject({ dimension: "runs", limit: DEFAULT_MAX_RUNS_PER_DAY })
		})

		it("still names the plain passes ceiling for a priority start", () => {
			expect(
				verdict({ runs: 1, passes: DEFAULT_MAX_PASSES_PER_DAY, passCount: 1, severity: "high" }),
			).toMatchObject({ dimension: "passes", limit: DEFAULT_MAX_PASSES_PER_DAY })
		})
	})
})
