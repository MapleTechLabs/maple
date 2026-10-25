import { compareAlertThreshold, maxSeverity, tierFor } from "@maple/alerting-core"
import {
	ALERT_SEVERITY_RANK,
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

/** Destinations an incident at `severity` notifies: its tier and every tier under it. */
const destinationsUpTo = (
	thresholds: ReadonlyArray<AlertThreshold>,
	severity: AlertSeverity,
): ReadonlyArray<AlertDestinationId> =>
	Arr.dedupe(
		thresholds
			.filter((tier) => ALERT_SEVERITY_RANK[tier.severity] <= ALERT_SEVERITY_RANK[severity])
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
 * The rule as one notification sees it: that tier's threshold and destinations. `reachedSeverity`
 * (the peak) widens them so a de-escalation or resolve reaches the pager that heard the critical.
 */
export const ruleAtSeverity = <R extends TieredRuleFields>(
	rule: R,
	severity: AlertSeverity,
	reachedSeverity: AlertSeverity | null = null,
): R => {
	const tier = tierFor(rule.thresholds, severity)
	return {
		...rule,
		severity,
		threshold: tier.value,
		thresholdUpper: tier.upper,
		destinationIds: destinationsUpTo(rule.thresholds, maxSeverity(severity, reachedSeverity) ?? severity),
	}
}

/** Whether a recovery value still fits its tier after an edit to the value or comparator. */
export const recoveryValueFits = (
	comparator: AlertComparator,
	tier: Pick<AlertThreshold, "value" | "recoveryValue">,
): boolean =>
	tier.recoveryValue === null ||
	(!isRangeComparator(comparator) &&
		comparator !== "eq" &&
		comparator !== "neq" &&
		!compareAlertThreshold(tier.recoveryValue, comparator, tier.value))

/** Whether an edit changes what a tick is classified against; destinations aside. */
export const tierConditionChanged = (
	a: { readonly comparator: string; readonly thresholds: AlertThresholds },
	b: { readonly comparator: string; readonly thresholds: AlertThresholds },
): boolean => {
	const key = (rule: typeof a) =>
		JSON.stringify([
			rule.comparator,
			rule.thresholds.map((t) => [t.severity, t.value, t.upper, t.recoveryValue]),
		])
	return key(a) !== key(b)
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
	const singleTierOnly = range || comparator === "eq" || comparator === "neq"
	if (new Set(thresholds.map((tier) => tier.severity)).size !== thresholds.length) {
		details.push("thresholds must have at most one tier per severity")
	}
	if (thresholds.length > 1 && singleTierOnly) {
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
			if (singleTierOnly) {
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
	// Tier ordering is strict even for inclusive comparators: equal tiers would always fire together.
	const strict = comparator === "gte" ? "gt" : comparator === "lte" ? "lt" : comparator
	const [warning, critical] = sortAlertThresholds(thresholds)
	if (
		warning !== undefined &&
		critical !== undefined &&
		Number.isFinite(warning.value) &&
		Number.isFinite(critical.value)
	) {
		if (!compareAlertThreshold(critical.value, strict, warning.value)) {
			details.push("the critical threshold must be worse than the warning threshold")
		}
		if (
			critical.recoveryValue != null &&
			compareAlertThreshold(warning.value, strict, critical.recoveryValue)
		) {
			details.push("the critical recovery value must not be past the warning threshold")
		}
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
