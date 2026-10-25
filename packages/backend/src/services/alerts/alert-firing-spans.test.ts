import { Effect } from "effect"
import { describe, expect, it } from "vitest"

import type { AlertEvaluationStatus } from "@maple/domain/http"
import { simulateFiringSpans, type AlertReplayPolicy, type SimulatedEvaluation } from "./alert-firing-spans"

// The simulation runs the scheduler's lifecycle planner. It has no services,
// no failures, and no time of its own.
const spansOf = (
	evaluations: ReadonlyArray<SimulatedEvaluation>,
	policy: AlertReplayPolicy,
	windowMs: number,
) => Effect.runSync(simulateFiringSpans(evaluations, policy, windowMs))

const thresholds = (breaches: number, healthy: number): AlertReplayPolicy => ({
	consecutiveBreachesRequired: breaches,
	breachesOutOf: null,
	evaluationIntervalMinutes: null,
	slowedIntervalMinutes: null,
	consecutiveHealthyRequired: healthy,
	thresholds: [{ severity: "warning" }],
})

const MINUTE = 60_000

describe("simulateFiringSpans", () => {
	const evaluations = (
		statuses: ReadonlyArray<AlertEvaluationStatus>,
		options?: { readonly provisionalLast?: boolean },
	): ReadonlyArray<SimulatedEvaluation> =>
		statuses.map((status, i) => ({
			bucketMs: i * MINUTE,
			evaluation: {
				status,
				value: status === "skipped" ? null : 1,
				sampleCount: 1,
				threshold: 1,
				thresholdUpper: null,
				comparator: "gte",
				reason: "test",
				derivedFromNoData: false,
				...(status === "skipped" ? { skipReason: "below_min_samples" as const } : undefined),
				levels:
					status === "skipped"
						? []
						: [{ severity: "warning", status: status === "breached" ? "breach" : "clear" }],
			},
			provisional: options?.provisionalLast === true && i === statuses.length - 1,
		}))

	it("opens at the start of the run's first breached window, not the one that tripped it", () => {
		const spans = spansOf(
			evaluations(["healthy", "breached", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		// The second breach trips the counter at t=2m, but the incident began with
		// the first breach at t=1m; it resolves at the end of the second healthy.
		expect(spans).toEqual([{ startMs: 1 * MINUTE, endMs: 5 * MINUTE, severity: "warning" }])
	})

	it("does not resolve on a single healthy window when two are required", () => {
		const spans = spansOf(
			evaluations(["breached", "breached", "healthy", "breached", "breached"]),
			thresholds(2, 2),
			MINUTE,
		)
		// One healthy resets the breach counter but never reaches the resolve bar,
		// so the whole stretch is one continuous span left open at the end.
		expect(spans).toEqual([{ startMs: 0, endMs: 5 * MINUTE, severity: "warning" }])
	})

	// Skipped windows freeze the machine, so a breach run survives a gap in data
	// instead of being silently reset by it.
	it("carries a breach run across a skipped window", () => {
		const spans = spansOf(
			evaluations(["breached", "skipped", "breached", "healthy", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		// The span starts at the first breach, not one window before the tripping one.
		expect(spans).toEqual([{ startMs: 0, endMs: 5 * MINUTE, severity: "warning" }])
	})

	// The trailing in-progress window charts, but the scheduler has not evaluated
	// it — letting it fire would show an incident the rule has not opened.
	it("ignores the provisional window entirely", () => {
		const spans = spansOf(
			evaluations(["healthy", "healthy", "breached", "breached"], { provisionalLast: true }),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})

	it("closes a still-open run at the last complete window's boundary", () => {
		const spans = spansOf(evaluations(["breached", "breached", "breached"]), thresholds(2, 2), MINUTE)
		expect(spans).toEqual([{ startMs: 0, endMs: 3 * MINUTE, severity: "warning" }])
	})

	it("returns nothing when the breach requirement is never met", () => {
		const spans = spansOf(
			evaluations(["breached", "healthy", "breached", "healthy"]),
			thresholds(2, 2),
			MINUTE,
		)
		expect(spans).toEqual([])
	})

	it("starts a re-opened span after the previous one, even with breaches left in the window", () => {
		const spans = spansOf(
			evaluations(["breached", "breached", "healthy", "breached", "healthy"]),
			{ ...thresholds(2, 1), breachesOutOf: 5 },
			MINUTE,
		)
		expect(spans).toEqual([
			{ startMs: 0, endMs: 3 * MINUTE, severity: "warning" },
			{ startMs: 3 * MINUTE, endMs: 5 * MINUTE, severity: "warning" },
		])
	})

	it("splits a span where the incident changes severity", () => {
		const tiered: AlertReplayPolicy = {
			...thresholds(2, 2),
			thresholds: [{ severity: "warning" }, { severity: "critical" }],
		}
		// 0 = clear, w = warning only, c = warning and critical.
		const ticks = ["w", "w", "c", "c", "w", "w", "0", "0"] as const
		const spans = spansOf(
			ticks.map((tick, i) => ({
				bucketMs: i * MINUTE,
				evaluation: {
					status: tick === "0" ? "healthy" : "breached",
					value: 1,
					sampleCount: 1,
					threshold: 1,
					thresholdUpper: null,
					comparator: "gte",
					reason: "test",
					derivedFromNoData: false,
					levels: [
						{ severity: "warning", status: tick === "0" ? "clear" : "breach" },
						{ severity: "critical", status: tick === "c" ? "breach" : "clear" },
					],
				},
			})),
			tiered,
			MINUTE,
		)
		expect(spans).toEqual([
			{ startMs: 0, endMs: 3 * MINUTE, severity: "warning" },
			{ startMs: 3 * MINUTE, endMs: 5 * MINUTE, severity: "critical" },
			{ startMs: 5 * MINUTE, endMs: 8 * MINUTE, severity: "warning" },
		])
	})
})
