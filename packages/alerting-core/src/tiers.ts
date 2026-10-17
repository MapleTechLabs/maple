import {
	ALERT_SEVERITY_RANK,
	alertSeverityOrder,
	type AlertComparator,
	type AlertSeverity,
} from "@maple/domain/http"
import { Array as Arr, Option } from "effect"

/**
 * Severity tiers: one rule, a warning and a critical threshold, each with an
 * optional recovery value. Everything here is pure; the scheduler persists the
 * tick history and the open incident carries the current severity.
 */

/** Where one tick leaves one tier: past its trigger, inside the recovery band, or clear of it. */
export type AlertTierStatus = "clear" | "hold" | "breach"

export interface AlertThresholdTier {
	readonly severity: AlertSeverity
	readonly value: number
	readonly upper: number | null
	/** Null recovers as soon as the trigger stops holding. */
	readonly recoveryValue: number | null
}

export interface AlertTierLevel {
	readonly severity: AlertSeverity
	readonly status: AlertTierStatus
}

export interface TieredHysteresisPolicy {
	/** N: breaching ticks needed to activate a tier. */
	readonly breachesToOpen: number
	/** M: how many recent ticks the N are counted over. M = N is "N in a row". */
	readonly breachWindow: number
	/** R: trailing clear ticks needed to deactivate a tier. */
	readonly healthyToResolve: number
}

export const compareAlertThreshold = (
	value: number,
	comparator: AlertComparator,
	threshold: number,
	thresholdUpper: number | null = null,
): boolean => {
	switch (comparator) {
		case "gt":
			return value > threshold
		case "gte":
			return value >= threshold
		case "lt":
			return value < threshold
		case "lte":
			return value <= threshold
		case "eq":
			return value === threshold
		case "neq":
			return value !== threshold
		case "between":
			return thresholdUpper != null && value >= threshold && value <= thresholdUpper
		case "not_between":
			return thresholdUpper != null && (value < threshold || value > thresholdUpper)
	}
}

export const classifyTier = (
	value: number,
	comparator: AlertComparator,
	tier: AlertThresholdTier,
): AlertTierStatus => {
	if (compareAlertThreshold(value, comparator, tier.value, tier.upper)) return "breach"
	if (tier.recoveryValue === null) return "clear"
	// Still on the breaching side of the recovery value: the dead band.
	return compareAlertThreshold(value, comparator, tier.recoveryValue) ? "hold" : "clear"
}

const STATUS_CODE = { clear: 0, hold: 1, breach: 2 } as const satisfies Record<AlertTierStatus, number>
const CODE_STATUS: ReadonlyArray<AlertTierStatus> = ["clear", "hold", "breach"]

/** One tick as a small int: two bits per tier, warning low, critical high. */
export const encodeTick = (levels: ReadonlyArray<AlertTierLevel>): number =>
	levels.reduce((code, level) => code | (STATUS_CODE[level.status] << shiftOf(level.severity)), 0)

const tierStatusAt = (code: number, severity: AlertSeverity): AlertTierStatus =>
	CODE_STATUS[(code >> shiftOf(severity)) & 0b11] ?? "clear"

const shiftOf = (severity: AlertSeverity) => (ALERT_SEVERITY_RANK[severity] - 1) * 2

const historyLength = (policy: TieredHysteresisPolicy) =>
	Math.max(policy.breachWindow, policy.breachesToOpen, policy.healthyToResolve)

/**
 * Append a tick, keeping only what the policy can still read. A steady rule
 * produces the same array tick after tick, which is what lets the scheduler
 * skip the state upsert.
 */
export const appendTick = (
	history: ReadonlyArray<number>,
	code: number,
	policy: TieredHysteresisPolicy,
): ReadonlyArray<number> => [...history, code].slice(-historyLength(policy))

const trailingRun = (history: ReadonlyArray<number>, matches: (code: number) => boolean): number =>
	Option.match(
		Arr.findLastIndex(history, (code) => !matches(code)),
		{ onNone: () => history.length, onSome: (index) => history.length - 1 - index },
	)

const anyBreach = (code: number) =>
	tierStatusAt(code, "warning") === "breach" || tierStatusAt(code, "critical") === "breach"

/**
 * The group's severity after the newest tick. A tier activates when that tick and N of the last M
 * breach it; an active tier stays until its last R ticks are clear (`hold` counts as neither).
 */
export const resolveActiveSeverity = (
	history: ReadonlyArray<number>,
	severities: ReadonlyArray<AlertSeverity>,
	current: AlertSeverity | null,
	policy: TieredHysteresisPolicy,
): AlertSeverity | null => {
	const newest = history.at(-1)
	if (newest === undefined) return current
	const recent = history.slice(-policy.breachWindow)
	const currentRank = current === null ? 0 : ALERT_SEVERITY_RANK[current]
	const ordered = [...severities].sort((a, b) => ALERT_SEVERITY_RANK[b] - ALERT_SEVERITY_RANK[a])
	for (const severity of ordered) {
		const breaches = recent.filter((code) => tierStatusAt(code, severity) === "breach").length
		if (tierStatusAt(newest, severity) === "breach" && breaches >= policy.breachesToOpen) return severity
		if (currentRank >= ALERT_SEVERITY_RANK[severity]) {
			const cleared = trailingRun(history, (code) => tierStatusAt(code, severity) === "clear")
			if (cleared < policy.healthyToResolve) return severity
		}
	}
	return null
}

/** Every tier past its recovery value: a tick in the recovery band is not healthy yet. */
const allClear = (code: number) =>
	tierStatusAt(code, "warning") === "clear" && tierStatusAt(code, "critical") === "clear"

/** The breach / healthy run lengths the audit trail and old readers expect. */
export const countersFromHistory = (
	history: ReadonlyArray<number>,
	policy: TieredHysteresisPolicy,
): { readonly consecutiveBreaches: number; readonly consecutiveHealthy: number } => ({
	consecutiveBreaches: Math.min(trailingRun(history, anyBreach), policy.breachesToOpen),
	consecutiveHealthy: Math.min(trailingRun(history, allClear), policy.healthyToResolve),
})

/**
 * A history for a state row written before histories existed. The counters
 * are trailing runs, at most one of them non-zero, so they replay exactly.
 */
export const seedHistory = (
	counters: { readonly consecutiveBreaches: number; readonly consecutiveHealthy: number },
	severity: AlertSeverity,
	policy: TieredHysteresisPolicy,
): ReadonlyArray<number> => {
	const breach = encodeTick([{ severity, status: "breach" }])
	const ticks = [
		...Array.from({ length: counters.consecutiveHealthy }, () => 0),
		...Array.from({ length: counters.consecutiveBreaches }, () => breach),
	]
	return ticks.slice(-historyLength(policy))
}

/**
 * The tier a severity reads from: its own, else the lowest one (a rule edited
 * to drop the tier an open incident sits at).
 */
export const tierFor = (
	tiers: Arr.NonEmptyReadonlyArray<AlertThresholdTier>,
	severity: AlertSeverity,
): AlertThresholdTier =>
	tiers.find((tier) => tier.severity === severity) ?? Arr.headNonEmpty(Arr.sort(tiers, alertSeverityOrder))

/**
 * The rule tier an incident at `severity` reads as: its own, else the one the rule kept
 * (with two severities there is only one other).
 */
export const nearestSeverity = (
	severity: AlertSeverity,
	severities: ReadonlyArray<AlertSeverity>,
): AlertSeverity => (severities.includes(severity) ? severity : (severities[0] ?? severity))

export const maxSeverity = (a: AlertSeverity | null, b: AlertSeverity | null): AlertSeverity | null =>
	a === null ? b : b === null ? a : ALERT_SEVERITY_RANK[a] >= ALERT_SEVERITY_RANK[b] ? a : b

/** The highest tier a tick breached, for the audit trail; null when none did. */
export const highestBreachedLevel = (levels: ReadonlyArray<AlertTierLevel>): AlertSeverity | null =>
	levels
		.filter((level) => level.status === "breach")
		.reduce<AlertSeverity | null>((highest, level) => maxSeverity(highest, level.severity), null)
