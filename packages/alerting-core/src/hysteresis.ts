import { Effect } from "effect"

/**
 * THE breach/recovery hysteresis shared by the two incident paths.
 *
 * `advanceAlertCounters` (user-configured rules) and `decideTransition` (the
 * zero-config anomaly detector) were the same mechanic spelled twice: breach on
 * N consecutive ticks to open, be healthy on M consecutive ticks to resolve.
 * The anomaly copy additionally guards re-opening with a cooldown.
 *
 * Every caller is a cron tick holding a Postgres row, so this folds one
 * observation into the row's counters with no runtime, fibers, or timers.
 * Wall time arrives as an argument because a tick knows `now`.
 */

export interface HysteresisConfig {
	/** Consecutive breaching ticks before an incident opens. */
	readonly breachesToOpen: number
	/** Consecutive healthy ticks before an open incident resolves. */
	readonly healthyToResolve: number
	/** Quiet period after a resolve during which re-opening is suppressed. 0 disables it. */
	readonly cooldownMs: number
}

/**
 * The persisted shape both callers already store: `alert_rule_states` and
 * `anomaly_detector_states` keep counters plus whether an incident stands.
 * Incident *identity* (attach, reopen, the per-tick open budget) lives in the
 * services, so a fold that says "open" can still be deferred.
 */
export interface HysteresisRow {
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
	readonly incidentOpen: boolean
	readonly lastResolvedAtMs: number | null
}

/** Same verdicts the two hand-rolled predecessors returned, to the letter. */
export interface HysteresisOutcome {
	readonly transition: "open" | "continue" | "resolve" | "noop"
	readonly consecutiveBreaches: number
	readonly consecutiveHealthy: number
}

/** Whether a resolve at `lastResolvedAtMs` still suppresses re-opens at `nowMs`. */
const cooling = (row: HysteresisRow, config: HysteresisConfig, nowMs: number): boolean =>
	row.lastResolvedAtMs !== null && config.cooldownMs > 0 && nowMs < row.lastResolvedAtMs + config.cooldownMs

/**
 * Counters saturate at their requirement because they are only ever compared
 * with `>=`. That keeps open/resolve behaviour identical while letting a
 * steady-state tick recognise its row as unchanged and skip the upsert.
 */
const fold = (
	row: HysteresisRow,
	status: "breached" | "healthy" | "skipped",
	config: HysteresisConfig,
	nowMs: number,
): HysteresisOutcome => {
	const { breachesToOpen, healthyToResolve } = config
	if (row.incidentOpen) {
		if (status === "skipped") {
			return {
				transition: "noop",
				consecutiveBreaches: row.consecutiveBreaches,
				consecutiveHealthy: row.consecutiveHealthy,
			}
		}
		if (status === "breached") {
			return {
				transition: "continue",
				consecutiveBreaches: Math.min(row.consecutiveBreaches + 1, breachesToOpen),
				consecutiveHealthy: 0,
			}
		}
		// A healthy window clears the breach run even while the incident stands:
		// the run that opened it is over, and a later re-breach counts from one.
		const consecutiveHealthy = Math.min(row.consecutiveHealthy + 1, healthyToResolve)
		return {
			transition: consecutiveHealthy < healthyToResolve ? "noop" : "resolve",
			consecutiveBreaches: 0,
			consecutiveHealthy,
		}
	}

	// Not open: a breach run in progress owns the row, otherwise the healthy run does.
	const breaching = row.consecutiveBreaches > 0
	const priorBreaches = breaching ? row.consecutiveBreaches : 0
	const priorHealthy = breaching ? 0 : row.consecutiveHealthy
	if (status === "skipped") {
		return { transition: "noop", consecutiveBreaches: priorBreaches, consecutiveHealthy: priorHealthy }
	}
	if (status === "breached") {
		const consecutiveBreaches = Math.min(priorBreaches + 1, breachesToOpen)
		const opens = consecutiveBreaches >= breachesToOpen && !cooling(row, config, nowMs)
		return { transition: opens ? "open" : "noop", consecutiveBreaches, consecutiveHealthy: 0 }
	}
	return {
		transition: "noop",
		consecutiveBreaches: 0,
		consecutiveHealthy: Math.min(priorHealthy + 1, healthyToResolve),
	}
}

/** Fold one evaluated window into the persisted counters and a verdict. */
export const foldObservation = (
	row: HysteresisRow,
	status: "breached" | "healthy" | "skipped",
	config: HysteresisConfig,
	nowMs: number,
): Effect.Effect<HysteresisOutcome> => Effect.sync(() => fold(row, status, config, nowMs))
