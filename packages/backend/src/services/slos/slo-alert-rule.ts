// The hidden `slo_burn_rate` alert rule behind each SLO, and what one evaluation of it observes.
import type { AlertEvaluation } from "@maple/alerting-core"
import type { AlertDestinationId, AlertThresholds } from "@maple/domain/http"
import {
	SLO_BURN_TIERS,
	SLO_BURN_LOOKBACK_MINUTES,
	budgetRemaining,
	budgetState,
	burnWindowOf,
	firingTier,
	severityState,
	sloRuleName,
	tierFactor,
	tierObserved,
	windowLabel,
	type SloBurnTier,
	type SloBurnWindow,
	type SloCounts,
	type SloSeverity,
} from "@maple/domain/slo"
import { Array as Arr, Option } from "effect"
import { MANAGED_RULE_PLAN } from "@maple/backend/services/alerts/AlertRuleModel"

/** The burn a severity fires at for this target: its most sensitive tier's. */
const severityFactor = (severity: SloSeverity, targetPercent: number): number =>
	Math.min(
		...Arr.map(
			Arr.filter(SLO_BURN_TIERS, (tier) => tier.severity === severity),
			(tier) => tierFactor(tier, targetPercent),
		),
	)

export interface SloRuleInput {
	readonly name: string
	readonly serviceName: string
	readonly environments: ReadonlyArray<string>
	readonly targetPercent: number
	readonly enabled: boolean
	readonly criticalDestinationIds: ReadonlyArray<AlertDestinationId>
	readonly warningDestinationIds: ReadonlyArray<AlertDestinationId>
}

/**
 * The stored thresholds and window of an SLO's rule for a target. Evaluation never reads them
 * (each tier is judged on its own windows); they are what an incident displays.
 */
export const sloRuleThresholds = (targetPercent: number) => ({
	valueOf: (severity: SloSeverity) => severityFactor(severity, targetPercent),
	threshold: severityFactor("warning", targetPercent),
	windowMinutes: SLO_BURN_LOOKBACK_MINUTES,
})

/**
 * The `alert_rules` columns of an SLO's burn-rate rule: a warning tier (ticket) and a critical
 * tier (page) at the burn factors its target can reach, checked every minute. One breached check
 * opens and one healthy check resolves: the short windows already keep it from flapping.
 */
export const sloRuleFields = (slo: SloRuleInput) => {
	const thresholds: AlertThresholds = [
		{
			severity: "warning",
			value: severityFactor("warning", slo.targetPercent),
			upper: null,
			recoveryValue: null,
			destinationIds: [...slo.warningDestinationIds],
		},
		{
			severity: "critical",
			value: severityFactor("critical", slo.targetPercent),
			upper: null,
			recoveryValue: null,
			destinationIds: [...slo.criticalDestinationIds],
		},
	]
	return {
		name: sloRuleName(slo.name),
		notes: null,
		notificationTemplateJson: null,
		enabled: slo.enabled,
		severity: "critical",
		serviceNamesJson: [slo.serviceName],
		excludeServiceNamesJson: null,
		environmentsJson: slo.environments.length === 0 ? null : [...slo.environments],
		tagsJson: null,
		groupBy: null,
		signalType: "slo_burn_rate",
		comparator: "gte",
		threshold: severityFactor("warning", slo.targetPercent),
		thresholdUpper: null,
		thresholdsJson: thresholds,
		windowMinutes: SLO_BURN_LOOKBACK_MINUTES,
		evaluationIntervalMinutes: 1,
		slowedIntervalMinutes: null,
		slowedAt: null,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		breachesOutOf: null,
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 60,
		apdexThresholdMs: null,
		queryBuilderDraftJson: null,
		rawQuerySql: null,
		destinationIdsJson: Arr.dedupe([...slo.criticalDestinationIds, ...slo.warningDestinationIds]),
		querySpecJson: null,
		reducer: MANAGED_RULE_PLAN.reducer,
		sampleCountStrategy: null,
		noDataBehavior: MANAGED_RULE_PLAN.noDataBehavior,
	} as const
}

const formatRate = (rate: number) => `${rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10}x`

const describeTier = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>, targetPercent: number) => {
	const rate = (minutes: number) =>
		Option.match(burnWindowOf(windows, minutes), { onNone: () => 0, onSome: (window) => window.burnRate })
	const long = rate(tier.longWindowMinutes)
	const short = rate(tier.shortWindowMinutes)
	const at = `${tier.severity} at ${formatRate(tierFactor(tier, targetPercent))}`
	const rates = `${formatRate(long)} over ${windowLabel(tier.longWindowMinutes)} and ${formatRate(short)} over ${windowLabel(tier.shortWindowMinutes)}`
	return { long, text: `burning the error budget at ${rates} (${at})`, rates: `${rates} (${at})` }
}

/** What one check of an SLO's burn reads. */
export interface SloBurnInput {
	readonly windows: ReadonlyArray<SloBurnWindow>
	readonly targetPercent: number
}

const warningFactor = (targetPercent: number) => severityFactor("warning", targetPercent)

/**
 * One check of an SLO's burn-rate rule. Each tier is judged on its own pair of windows, so the
 * levels are set here rather than by comparing one value to every tier. With no events in any
 * short window the check is skipped as no data.
 */
export const evaluateSloBurn = (input: SloBurnInput): AlertEvaluation => {
	const { windows, targetPercent } = input
	const hour = Option.getOrUndefined(burnWindowOf(windows, 60))
	const base = {
		sampleCount: Math.round(hour?.total ?? 0),
		threshold: warningFactor(targetPercent),
		thresholdUpper: null,
		comparator: "gte" as const,
		derivedFromNoData: false,
	}
	if (!Arr.some(SLO_BURN_TIERS, (tier) => tierObserved(tier, windows))) {
		return {
			...base,
			status: "skipped",
			value: null,
			reason: "No events in the SLO's short burn windows",
			skipReason: "no_data",
			levels: [],
		}
	}
	const burning = Option.orElse(firingTier("critical", windows, targetPercent), () =>
		firingTier("warning", windows, targetPercent),
	)
	return {
		...base,
		status: Option.isSome(burning) ? "breached" : "healthy",
		levels: [
			{ severity: "warning", status: severityState("warning", windows, targetPercent) },
			{ severity: "critical", status: severityState("critical", windows, targetPercent) },
		],
		value: Option.match(burning, {
			onNone: () => hour?.burnRate ?? 0,
			onSome: (tier) => describeTier(tier, windows, targetPercent).long,
		}),
		// A recovery names every tier, so a resolved warning reports the windows it fired on.
		reason: Option.match(burning, {
			onSome: (tier) => `SLO ${describeTier(tier, windows, targetPercent).text}`,
			onNone: () =>
				`SLO within budget: ${Arr.join(
					Arr.map(SLO_BURN_TIERS, (tier) => describeTier(tier, windows, targetPercent).rates),
					"; ",
				)}`,
		}),
	}
}

/** What the budget group's check knows of the SLO window, as the alert source read it. */
export type SloBudgetInput =
	| { readonly _tag: "read"; readonly totals: SloCounts }
	| { readonly _tag: "notDue" }
	| { readonly _tag: "unread" }

/**
 * One check of an SLO's error budget, its own alert group: a warning while the window's budget
 * is spent, cleared once it is back by a margin. The value is the share of the budget used. A
 * check with no read of the window judges nothing either way.
 */
export const evaluateSloBudget = (input: {
	readonly targetPercent: number
	readonly windowDays: number
	readonly budget: SloBudgetInput
}): AlertEvaluation => {
	const { targetPercent, budget } = input
	const base = {
		threshold: 1,
		thresholdUpper: null,
		comparator: "gte" as const,
		derivedFromNoData: false,
	}
	if (budget._tag !== "read") {
		return {
			...base,
			sampleCount: 0,
			status: "skipped",
			value: null,
			reason:
				budget._tag === "notDue"
					? "The error budget is read every few minutes, not on this check"
					: "The SLO window's events could not be read",
			skipReason: "no_value",
			levels: [],
		}
	}
	const state = budgetState(budget.totals, targetPercent)
	const used = 1 - budgetRemaining(budget.totals, targetPercent)
	const share = `${Math.round(used * 100)}% of the ${input.windowDays}-day budget used`
	return {
		...base,
		sampleCount: Math.round(budget.totals.total),
		status: state === "breach" ? "breached" : "healthy",
		levels: [
			{ severity: "warning", status: state },
			{ severity: "critical", status: "clear" },
		],
		value: used,
		reason:
			state === "breach" ? `SLO error budget is spent: ${share}` : `SLO error budget is back: ${share}`,
	}
}

/** What an SLO's budget incident is called in place of its group key. */
export const SLO_BUDGET_GROUP_LABEL = "Error budget"
