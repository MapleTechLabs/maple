import { Effect } from "effect"

import {
	maxSeverity,
	planAlertLifecycle,
	type AlertEvaluation,
	type AlertLifecycleIncident,
	type AlertLifecycleInput,
} from "@maple/alerting-core"
import type { AlertSeverity, AlertThreshold } from "@maple/domain/http"

/** The rule fields the lifecycle reads; nothing else about a rule matters here. */
export interface AlertReplayPolicy {
	readonly consecutiveBreachesRequired: number
	readonly breachesOutOf: number | null
	readonly consecutiveHealthyRequired: number
	readonly thresholds: ReadonlyArray<Pick<AlertThreshold, "severity">>
}

/** One observation the preview replays, in the order the scheduler would see it. */
export interface SimulatedEvaluation {
	readonly bucketMs: number
	readonly evaluation: AlertEvaluation
	/**
	 * The trailing in-progress window. It charts, but the scheduler has not
	 * evaluated it yet, so it stays out of the simulation entirely.
	 */
	readonly provisional?: boolean
}

/** A stretch of wall time the rule would have held an incident open, at its peak severity. */
export interface SimulatedFiringSpan {
	readonly startMs: number
	readonly endMs: number
	readonly severity: AlertSeverity
}

interface ReplayState {
	readonly state: AlertLifecycleInput["state"]
	readonly incident: AlertLifecycleIncident | null
	readonly open: { readonly startMs: number; readonly peak: AlertSeverity } | null
	/** Buckets of the recent non-skipped ticks that breached, to date a span's first breach. */
	readonly recentBreaches: ReadonlyArray<number | null>
	readonly lastCompleteBucketMs: number | null
	readonly spans: ReadonlyArray<SimulatedFiringSpan>
}

/**
 * Replay a series through the scheduler's own lifecycle planner and return the
 * spans during which the rule would have held an incident open.
 *
 * The preview promises to show what the scheduler will do, so it must not be a
 * second implementation of it: both run `planAlertLifecycle`. The preview cannot
 * probe telemetry liveness, so an empty window that the scheduler would hold on
 * is treated as evidence of nothing, and a value synthesized from no data may
 * resolve.
 *
 * A span opens at the run's first breached window inside the last M checks,
 * not the window that tripped the count. A run still open at the end of the
 * series closes at the last complete window's boundary.
 */
export const simulateFiringSpans = (
	evaluations: ReadonlyArray<SimulatedEvaluation>,
	rule: AlertReplayPolicy,
	windowMs: number,
): Effect.Effect<ReadonlyArray<SimulatedFiringSpan>> =>
	Effect.gen(function* () {
		const breachWindow = rule.breachesOutOf ?? rule.consecutiveBreachesRequired
		const policy: AlertLifecycleInput["policy"] = {
			consecutiveBreachesRequired: rule.consecutiveBreachesRequired,
			breachWindow,
			consecutiveHealthyRequired: rule.consecutiveHealthyRequired,
			renotifyIntervalMinutes: Number.MAX_SAFE_INTEGER,
			severities: rule.thresholds.map((tier) => tier.severity),
		}
		const initial: ReplayState = {
			state: null,
			incident: null,
			open: null,
			recentBreaches: [],
			lastCompleteBucketMs: null,
			spans: [],
		}

		const final = yield* Effect.reduce(
			evaluations.filter((tick) => tick.provisional !== true),
			() => initial,
			(acc, { bucketMs, evaluation }) =>
				planAlertLifecycle({
					policy,
					evaluation,
					state: acc.state,
					openIncident: acc.incident,
					nowMs: bucketMs,
					allowNoDataResolution: evaluation.status !== "skipped",
				}).pipe(
					Effect.map((plan): ReplayState => {
						const recentBreaches =
							evaluation.status === "skipped"
								? acc.recentBreaches
								: [
										...acc.recentBreaches,
										evaluation.status === "breached" ? bucketMs : null,
									].slice(-breachWindow)
						const incident: AlertLifecycleIncident | null =
							plan.transition === "resolved" || plan.severity === null
								? null
								: {
										severity: plan.severity,
										firstTriggeredAtMs: acc.incident?.firstTriggeredAtMs ?? bucketMs,
										lastNotifiedAtMs: bucketMs,
										lastDeliveredEventType: "trigger",
									}
						const base = {
							...acc,
							state: plan.state,
							incident,
							recentBreaches,
							lastCompleteBucketMs: bucketMs,
						}
						if (plan.transition === "opened" && plan.severity !== null) {
							const firstBreach = recentBreaches.find((ms) => ms !== null) ?? bucketMs
							return { ...base, open: { startMs: firstBreach, peak: plan.severity } }
						}
						if (plan.transition === "resolved" && acc.open !== null) {
							return {
								...base,
								open: null,
								spans: [
									...acc.spans,
									{
										startMs: acc.open.startMs,
										endMs: bucketMs + windowMs,
										severity: acc.open.peak,
									},
								],
							}
						}
						if (acc.open !== null && plan.severity !== null) {
							return {
								...base,
								open: {
									...acc.open,
									peak: maxSeverity(acc.open.peak, plan.severity) ?? plan.severity,
								},
							}
						}
						return base
					}),
				),
		)

		return final.open !== null && final.lastCompleteBucketMs !== null
			? [
					...final.spans,
					{
						startMs: final.open.startMs,
						endMs: final.lastCompleteBucketMs + windowMs,
						severity: final.open.peak,
					},
				]
			: final.spans
	})
