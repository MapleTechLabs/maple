// The hidden `slo_burn_rate` alert rule behind each SLO, and what one evaluation of it observes.
import type { AlertEvaluation } from "@maple/alerting-core"
import type { AlertDestinationId, AlertThresholds } from "@maple/domain/http"
import {
	SLO_BURN_TIERS,
	SLO_BURN_LOOKBACK_MINUTES,
	tierBreached,
	type SloBurnTier,
	type SloBurnWindow,
} from "@maple/domain/slo"
import { Array as Arr, Option } from "effect"
import { MANAGED_RULE_PLAN } from "@maple/backend/services/alerts/AlertRuleModel"

const [CRITICAL_TIER, WARNING_TIER] = SLO_BURN_TIERS

/** The rule's name: it titles incidents and notifications, so it says what is burning. */
export const sloRuleName = (sloName: string) => `SLO burn: ${sloName}`

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

const rateOf = (windows: ReadonlyArray<SloBurnWindow>, minutes: number) =>
	Arr.findFirst(windows, (window) => window.windowMinutes === minutes)

const formatRate = (rate: number) => `${rate >= 100 ? Math.round(rate) : Math.round(rate * 10) / 10}x`

const describeTier = (tier: SloBurnTier, windows: ReadonlyArray<SloBurnWindow>) => {
	const long = Option.match(rateOf(windows, tier.longWindowMinutes), { onNone: () => 0, onSome: (w) => w.burnRate })
	const short = Option.match(rateOf(windows, tier.shortWindowMinutes), {
		onNone: () => 0,
		onSome: (w) => w.burnRate,
	})
	const label = (minutes: number) => (minutes >= 60 ? `${minutes / 60}h` : `${minutes}m`)
	return {
		long,
		text: `burning the error budget at ${formatRate(long)} over ${label(tier.longWindowMinutes)} and ${formatRate(short)} over ${label(tier.shortWindowMinutes)} (${tier.severity} at ${tier.factor}x)`,
	}
}

/**
 * One check of an SLO's burn-rate rule. Each tier is judged on its own pair of windows, so the
 * levels are set here rather than by comparing one value to every tier. The value is the
 * long-window burn of the highest tier that fires, else the 1h burn.
 */
export const evaluateSloBurn = (windows: ReadonlyArray<SloBurnWindow>): AlertEvaluation => {
	const levels = Arr.map([WARNING_TIER, CRITICAL_TIER], (tier) => ({
		severity: tier.severity,
		status: tierBreached(tier, windows) ? ("breach" as const) : ("clear" as const),
	}))
	const firing = Arr.findFirst([CRITICAL_TIER, WARNING_TIER], (tier) => tierBreached(tier, windows))
	const headline = describeTier(Option.getOrElse(firing, () => CRITICAL_TIER), windows)
	const hour = Option.getOrUndefined(rateOf(windows, CRITICAL_TIER.longWindowMinutes))
	return {
		status: Option.isSome(firing) ? "breached" : "healthy",
		levels,
		value: headline.long,
		sampleCount: Math.round(hour?.total ?? 0),
		threshold: WARNING_TIER.factor,
		thresholdUpper: null,
		comparator: "gte",
		reason: Option.isSome(firing) ? `SLO ${headline.text}` : `SLO within budget: ${headline.text}`,
		derivedFromNoData: false,
	}
}
