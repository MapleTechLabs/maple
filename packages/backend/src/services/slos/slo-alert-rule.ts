// The hidden `slo_burn_rate` alert rule behind each SLO, and what one evaluation of it observes.
import type { AlertEvaluation } from "@maple/alerting-core"
import type { AlertDestinationId, AlertThresholds } from "@maple/domain/http"
import {
	SLO_BURN_TIERS,
	SLO_BURN_LOOKBACK_MINUTES,
	burnWindowOf,
	sloRuleName,
	tierState,
	windowLabel,
	type SloBurnTier,
	type SloBurnWindow,
} from "@maple/domain/slo"
import { Array as Arr, Option } from "effect"
import { MANAGED_RULE_PLAN } from "@maple/backend/services/alerts/AlertRuleModel"

const [CRITICAL_TIER, WARNING_TIER] = SLO_BURN_TIERS

export interface SloRuleInput {
	readonly name: string
	readonly serviceName: string
	readonly environments: ReadonlyArray<string>
	readonly enabled: boolean
	readonly criticalDestinationIds: ReadonlyArray<AlertDestinationId>
	readonly warningDestinationIds: ReadonlyArray<AlertDestinationId>
}

/**
 * The `alert_rules` columns of an SLO's burn-rate rule: a warning tier (ticket) and a critical
 * tier (page) at their burn factors, checked every minute. One breached check opens and one
 * healthy check resolves: the short windows already keep it from flapping.
 */
export const sloRuleFields = (slo: SloRuleInput) => {
	const thresholds: AlertThresholds = [
		{
			severity: "warning",
			value: WARNING_TIER.factor,
			upper: null,
			recoveryValue: null,
			destinationIds: [...slo.warningDestinationIds],
		},
		{
			severity: "critical",
			value: CRITICAL_TIER.factor,
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
		threshold: WARNING_TIER.factor,
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

const describeTier = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>) => {
	const rate = (minutes: number) =>
		Option.match(burnWindowOf(windows, minutes), { onNone: () => 0, onSome: (window) => window.burnRate })
	const long = rate(tier.longWindowMinutes)
	const short = rate(tier.shortWindowMinutes)
	return {
		long,
		text: `burning the error budget at ${formatRate(long)} over ${windowLabel(tier.longWindowMinutes)} and ${formatRate(short)} over ${windowLabel(tier.shortWindowMinutes)} (${tier.severity} at ${tier.factor}x)`,
	}
}

/**
 * One check of an SLO's burn-rate rule. Each tier is judged on its own pair of windows, so the
 * levels are set here rather than by comparing one value to every tier. A tier whose short
 * window saw no events holds its state; with every tier held the check is skipped as no data.
 * The value is the long-window burn of the highest tier that fires, else the 1h burn.
 */
export const evaluateSloBurn = (windows: ReadonlyArray<SloBurnWindow>): AlertEvaluation => {
	const tiers = [WARNING_TIER, CRITICAL_TIER]
	const levels = Arr.map(tiers, (tier) => ({
		severity: tier.severity,
		status: tierState(tier, windows),
	}))
	const hour = Option.getOrUndefined(burnWindowOf(windows, CRITICAL_TIER.longWindowMinutes))
	const base = {
		sampleCount: Math.round(hour?.total ?? 0),
		threshold: WARNING_TIER.factor,
		thresholdUpper: null,
		comparator: "gte" as const,
		derivedFromNoData: false,
	}
	if (Arr.every(levels, (level) => level.status === "hold")) {
		return {
			...base,
			status: "skipped",
			value: null,
			reason: "No events in the SLO's short burn windows",
			skipReason: "no_data",
			levels: [],
		}
	}
	const firing = Arr.findFirst([CRITICAL_TIER, WARNING_TIER], (tier) =>
		Arr.some(levels, (level) => level.severity === tier.severity && level.status === "breach"),
	)
	const headline = describeTier(
		Option.getOrElse(firing, () => CRITICAL_TIER),
		windows,
	)
	return {
		...base,
		status: Option.isSome(firing) ? "breached" : "healthy",
		levels,
		value: headline.long,
		reason: Option.isSome(firing) ? `SLO ${headline.text}` : `SLO within budget: ${headline.text}`,
	}
}
