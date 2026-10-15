import {
	compareAlertThreshold,
	maxSeverity,
	SEVERITY_RANK,
	tierFor,
	type AlertThresholdTier,
} from "@maple/alerting-core"
import {
	isRangeComparator,
	MAX_ALERT_BREACH_WINDOW,
	sortAlertThresholds,
	type AlertComparator,
	type AlertDestinationId,
	type AlertSeverity,
	type AlertThreshold,
	type AlertThresholds,
} from "@maple/domain/http"
import { Array as Arr } from "effect"

export const coreTiers = (thresholds: AlertThresholds): Arr.NonEmptyReadonlyArray<AlertThresholdTier> =>
	Arr.map(thresholds, ({ severity, value, upper, recoveryValue }) => ({
		severity,
		value,
		upper,
		recoveryValue,
	}))

/** Destinations an incident at `severity` notifies: its tier and every tier under it. */
export const destinationsUpTo = (
	thresholds: ReadonlyArray<AlertThreshold>,
	severity: AlertSeverity,
): ReadonlyArray<AlertDestinationId> =>
	Arr.dedupe(
		thresholds
			.filter((tier) => SEVERITY_RANK[tier.severity] <= SEVERITY_RANK[severity])
			.flatMap((tier) => tier.destinationIds),
	)

interface TieredRuleFields {
	readonly thresholds: AlertThresholds
	readonly severity: AlertSeverity
	readonly threshold: number
	readonly thresholdUpper: number | null
	readonly destinationIds: ReadonlyArray<AlertDestinationId>
}

/**
 * The rule as one notification sees it: the severity the incident is at, that
 * tier's threshold, and the destinations everyone notified so far. `reachedSeverity`
 * is the incident's peak, so a de-escalation or resolve still reaches the pager
 * that heard the critical. A one-tier rule comes back unchanged.
 */
export const ruleAtSeverity = <R extends TieredRuleFields>(
	rule: R,
	severity: AlertSeverity,
	reachedSeverity: AlertSeverity | null = null,
): R => {
	const tier = tierFor(coreTiers(rule.thresholds), severity)
	return {
		...rule,
		severity,
		threshold: tier.value,
		thresholdUpper: tier.upper,
		destinationIds: destinationsUpTo(rule.thresholds, maxSeverity(severity, reachedSeverity) ?? severity),
	}
}

/**
 * Validation messages for a tier list. `label` names a field for the message,
 * so a request in the single-threshold shape keeps its old wording.
 */
export const validateThresholds = (
	comparator: AlertComparator,
	thresholds: AlertThresholds,
	options: {
		readonly label: (index: number, field: "value" | "upper" | "recoveryValue") => string
		readonly requireDestinations: boolean
	},
): ReadonlyArray<string> => {
	const details: string[] = []
	const { label } = options
	const range = isRangeComparator(comparator)
	if (new Set(thresholds.map((tier) => tier.severity)).size !== thresholds.length) {
		details.push("thresholds must have at most one tier per severity")
	}
	if (thresholds.length > 1 && (range || comparator === "eq" || comparator === "neq")) {
		details.push(`only one threshold tier is supported with the ${comparator} comparator`)
	}
	thresholds.forEach((tier, index) => {
		if (!Number.isFinite(tier.value)) details.push(`${label(index, "value")} must be a finite number`)
		if (range) {
			if (tier.upper == null || !Number.isFinite(tier.upper)) {
				details.push(`${label(index, "upper")} is required for between / not_between comparators`)
			} else if (tier.upper < tier.value) {
				details.push(
					`${label(index, "upper")} must be greater than or equal to ${label(index, "value")}`,
				)
			}
		} else if (tier.upper != null) {
			details.push(`${label(index, "upper")} is only supported for between / not_between comparators`)
		}
		if (tier.recoveryValue != null) {
			if (range || comparator === "eq" || comparator === "neq") {
				details.push(
					`${label(index, "recoveryValue")} is not supported with the ${comparator} comparator`,
				)
			} else if (!Number.isFinite(tier.recoveryValue)) {
				details.push(`${label(index, "recoveryValue")} must be a finite number`)
			} else if (compareAlertThreshold(tier.recoveryValue, comparator, tier.value)) {
				details.push(
					`${label(index, "recoveryValue")} must be on the healthy side of ${label(index, "value")}`,
				)
			}
		}
		if (options.requireDestinations && tier.destinationIds.length === 0) {
			details.push(
				thresholds.length === 1
					? "at least one destination must be selected"
					: `the ${tier.severity} threshold needs at least one destination`,
			)
		}
	})
	const sorted = sortAlertThresholds(thresholds)
	const [warning, critical] = sorted
	if (
		sorted.length === 2 &&
		warning !== undefined &&
		critical !== undefined &&
		Number.isFinite(warning.value) &&
		Number.isFinite(critical.value) &&
		!compareAlertThreshold(critical.value, comparator, warning.value)
	) {
		details.push("the critical threshold must be worse than the warning threshold")
	}
	return details
}

export const validateBreachWindow = (
	breachesRequired: number,
	breachesOutOf: number | null,
): ReadonlyArray<string> =>
	breachesOutOf === null
		? []
		: breachesOutOf < breachesRequired
			? ["breachesOutOf must be at least consecutiveBreachesRequired"]
			: breachesOutOf > MAX_ALERT_BREACH_WINDOW
				? [`breachesOutOf must be at most ${MAX_ALERT_BREACH_WINDOW}`]
				: []
