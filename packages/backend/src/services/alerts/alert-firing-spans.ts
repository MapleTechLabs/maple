import { Effect } from "effect"

import {
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

/** A stretch of wall time the rule would have held an incident open at one severity. */
export interface SimulatedFiringSpan {
	readonly startMs: number
	readonly endMs: number
	readonly severity: AlertSeverity
}

interface ReplayState {
	readonly state: AlertLifecycleInput["state"]
	readonly incident: AlertLifecycleIncident | null
	readonly open: { readonly startMs: number; readonly severity: AlertSeverity } | null
	/** Buckets of the recent non-skipped ticks that breached, to date a span's first breach. */
	readonly recentBreaches: ReadonlyArray<number | null>
	readonly lastCompleteBucketMs: number | null
	readonly spans: ReadonlyArray<SimulatedFiringSpan>
}

/**
 * Replay a series through the scheduler's `planAlertLifecycle` (no liveness probe, so empty windows
 * are evidence of nothing). Spans start at the first breach inside the last M checks, split at each
 * severity change, and an open run closes at the last complete window.
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
							return { ...base, open: { startMs: firstBreach, severity: plan.severity } }
						}
						if (plan.transition === "resolved" && acc.open !== null) {
							return {
								...base,
								open: null,
								// A re-open within M must not date back past this resolve.
								recentBreaches: [],
								spans: [
									...acc.spans,
									{
										startMs: acc.open.startMs,
										endMs: bucketMs + windowMs,
										severity: acc.open.severity,
									},
								],
							}
						}
						if (
							acc.open !== null &&
							plan.severity !== null &&
							plan.severity !== acc.open.severity
						) {
							return {
								...base,
								open: { startMs: bucketMs, severity: plan.severity },
								spans: [
									...acc.spans,
									{
										startMs: acc.open.startMs,
										endMs: bucketMs,
										severity: acc.open.severity,
									},
								],
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
						severity: final.open.severity,
					},
				]
			: final.spans
	})
