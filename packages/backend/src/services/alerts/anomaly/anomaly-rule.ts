import {
	alertThresholdLegacyFields,
	type AlertThresholds,
	type AnomalyIncidentSeverity,
	type AnomalySignalType,
	type OrgId,
} from "@maple/domain/http"
import { Array as Arr, Option, Order } from "effect"
import { formatSignalMetric } from "../alert-formatting"
import type { SignalDisplay } from "../alert-signal-display"

/** The observed value of an anomaly rule: 0 is no open anomaly, then warning and critical. */
export type AnomalySeverityCode = 0 | 1 | 2

export const anomalySeverityCode = (severity: AnomalyIncidentSeverity): 1 | 2 =>
	severity === "critical" ? 2 : 1

/** The fields every anomaly rule is pinned to: one breach opens, one quiet check resolves. */
export const ANOMALY_RULE_DEFAULTS = {
	comparator: "gte",
	windowMinutes: 5,
	evaluationIntervalMinutes: 1,
	consecutiveBreachesRequired: 1,
	breachesOutOf: null,
	consecutiveHealthyRequired: 1,
	minimumSampleCount: 0,
	renotifyIntervalMinutes: 30,
} as const

export const DEFAULT_ANOMALY_RULE_NAME = "Anomaly detection"
/** Used when a user already took the default name for another rule. */
export const DEFAULT_ANOMALY_RULE_FALLBACK_NAME = "Anomaly detection (default)"

export const DEFAULT_ANOMALY_RULE_SYSTEM_MESSAGE =
	"Maple creates the default anomaly rule; scope this rule by service, environment or signal"
export const DEFAULT_ANOMALY_RULE_SCOPE_MESSAGE =
	"The default anomaly rule covers every anomaly and cannot be scoped; create a scoped anomaly rule instead"
export const DEFAULT_ANOMALY_RULE_PROTECTED_MESSAGE =
	"The default anomaly rule cannot be deleted or disabled. Leave it with no destinations so the anomalies it handles only show in the app (scoped anomaly rules still page), or turn detection off with PATCH /v2/anomalies/settings (enabled: false)"

/** What an anomaly rule pages on. Each empty list matches everything. */
export interface AnomalyRuleScope {
	readonly serviceNames: ReadonlyArray<string>
	readonly environments: ReadonlyArray<string>
	readonly anomalySignals: ReadonlyArray<AnomalySignalType>
}

/** The org default: an anomaly rule with no scope at all. */
export const isDefaultAnomalyScope = (scope: AnomalyRuleScope): boolean =>
	scope.serviceNames.length === 0 && scope.environments.length === 0 && scope.anomalySignals.length === 0

/** The scope of a stored row, whose scope columns are null when empty. */
export const storedAnomalyScope = (row: {
	readonly serviceNamesJson: ReadonlyArray<string> | null
	readonly environmentsJson: ReadonlyArray<string> | null
	readonly anomalySignalsJson: ReadonlyArray<AnomalySignalType> | null
}): AnomalyRuleScope => ({
	serviceNames: row.serviceNamesJson ?? [],
	environments: row.environmentsJson ?? [],
	anomalySignals: row.anomalySignalsJson ?? [],
})

export interface AnomalyRuleCandidate extends AnomalyRuleScope {
	readonly id: string
	/** The code of the rule's lowest tier: a critical-only rule (2) has no tier for a warning. */
	readonly lowestSeverityCode: 1 | 2
}

export interface AnomalyIncidentScope {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly signalType: AnomalySignalType
	readonly severity: AnomalyIncidentSeverity
}

const inScope = <A>(values: ReadonlyArray<A>, value: A): boolean =>
	values.length === 0 || Arr.contains(values, value)

/** Whether an anomaly falls inside a rule's scope; each empty list matches everything. */
export const anomalyScopeCovers = (
	rule: AnomalyRuleScope,
	incident: Pick<AnomalyIncidentScope, "serviceName" | "deploymentEnv" | "signalType">,
): boolean =>
	inScope(rule.serviceNames, incident.serviceName) &&
	inScope(rule.environments, incident.deploymentEnv) &&
	inScope(rule.anomalySignals, incident.signalType)

const specificity = (scope: AnomalyRuleScope): number =>
	Arr.filter([scope.serviceNames, scope.environments, scope.anomalySignals], (values) => values.length > 0)
		.length

/** Most specific first, then the lowest id, so every tick assigns the same way. */
const candidateOrder = <R extends AnomalyRuleCandidate>(): Order.Order<R> =>
	Order.combine(
		Order.mapInput(Order.flip(Order.Number), (rule: R) => specificity(rule)),
		Order.mapInput(Order.String, (rule: R) => rule.id),
	)

/**
 * The one rule an open anomaly incident pages through: the most specific enabled rule whose
 * scope covers it and that has a tier at or below its severity, ties going to the lowest id.
 * An anomaly already paged by `currentRuleId` stays there while that rule still qualifies,
 * unless a qualifying rule is strictly more specific; then it hands over.
 */
export const assignAnomalyRule = <R extends AnomalyRuleCandidate>(
	rules: ReadonlyArray<R>,
	incident: AnomalyIncidentScope,
	currentRuleId: string | null = null,
): Option.Option<R> => {
	const code = anomalySeverityCode(incident.severity)
	const qualifying = Arr.sort(
		Arr.filter(rules, (rule) => anomalyScopeCovers(rule, incident) && rule.lowestSeverityCode <= code),
		candidateOrder<R>(),
	)
	const best = Arr.head(qualifying)
	const current = Arr.findFirst(qualifying, (rule) => rule.id === currentRuleId)
	if (Option.isNone(current) || Option.isNone(best)) return best
	return specificity(best.value) > specificity(current.value) ? best : current
}

const SIGNAL_NAMES = {
	error_rate: "error rate",
	latency_p95: "p95 latency",
	throughput: "throughput",
	log_volume: "error log volume",
	error_spike: "error spike",
} satisfies Record<AnomalySignalType, string>

/** A detector signal as people say it, e.g. "p95 latency". */
export const anomalySignalName = (signalType: AnomalySignalType): string => SIGNAL_NAMES[signalType]

/** How an anomaly's series is named where a group would be, e.g. "checkout (production)". */
export const anomalyGroupLabel = (incident: {
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly signalType: AnomalySignalType
}): string => {
	const subject = incident.serviceName.length > 0 ? incident.serviceName : SIGNAL_NAMES[incident.signalType]
	return incident.deploymentEnv.length > 0 ? `${subject} (${incident.deploymentEnv})` : subject
}

const metric = (value: number, unit: SignalDisplay["unit"]): string =>
	formatSignalMetric(value, { label: "", unit })

/** One sentence on what an open anomaly is doing, e.g. "error rate 4.2% vs baseline 0.3% in checkout (production)". */
export const describeAnomaly = (incident: {
	readonly signalType: AnomalySignalType
	readonly serviceName: string
	readonly deploymentEnv: string
	readonly lastObservedValue: number
	readonly baselineMedian: number
}): string => {
	const observed = incident.lastObservedValue
	const baseline = incident.baselineMedian
	const where =
		incident.serviceName.length === 0
			? ""
			: ` in ${incident.serviceName}${incident.deploymentEnv.length > 0 ? ` (${incident.deploymentEnv})` : ""}`
	switch (incident.signalType) {
		case "error_rate":
			return `error rate ${metric(observed, "ratio")} vs baseline ${metric(baseline, "ratio")}${where}`
		case "latency_p95":
			return `p95 latency ${metric(observed, "ms")} vs baseline ${metric(baseline, "ms")}${where}`
		case "throughput":
			return `throughput ${observed < baseline ? "dropped" : "rose"} to ${metric(observed, "rpm")} vs baseline ${metric(baseline, "rpm")}${where}`
		case "log_volume":
			return `error log volume ${metric(observed, "count")}/min vs baseline ${metric(baseline, "count")}/min${where}`
		case "error_spike":
			return `error spike: ${metric(Math.round(observed), "count")} errors in 30 min vs baseline ${metric(baseline, "count")}${where}`
	}
}

/** The org default anomaly rule's `alert_rules` columns: both tiers, unrouted until a user adds destinations. */
export const defaultAnomalyRuleFields = (orgId: OrgId, name: string = DEFAULT_ANOMALY_RULE_NAME) => {
	const thresholds: AlertThresholds = [
		{ severity: "warning", value: 1, upper: null, recoveryValue: null, destinationIds: [] },
		{ severity: "critical", value: 2, upper: null, recoveryValue: null, destinationIds: [] },
	]
	const legacy = alertThresholdLegacyFields(thresholds)
	return {
		orgId,
		name,
		notes: null,
		notificationTemplateJson: null,
		enabled: true,
		severity: legacy.severity,
		serviceNamesJson: null,
		excludeServiceNamesJson: null,
		environmentsJson: null,
		anomalySignalsJson: null,
		tagsJson: null,
		groupBy: null,
		signalType: "anomaly",
		comparator: ANOMALY_RULE_DEFAULTS.comparator,
		threshold: legacy.threshold,
		thresholdUpper: legacy.thresholdUpper,
		thresholdsJson: thresholds,
		windowMinutes: ANOMALY_RULE_DEFAULTS.windowMinutes,
		evaluationIntervalMinutes: ANOMALY_RULE_DEFAULTS.evaluationIntervalMinutes,
		slowedIntervalMinutes: null,
		slowedAt: null,
		minimumSampleCount: ANOMALY_RULE_DEFAULTS.minimumSampleCount,
		consecutiveBreachesRequired: ANOMALY_RULE_DEFAULTS.consecutiveBreachesRequired,
		breachesOutOf: ANOMALY_RULE_DEFAULTS.breachesOutOf,
		consecutiveHealthyRequired: ANOMALY_RULE_DEFAULTS.consecutiveHealthyRequired,
		renotifyIntervalMinutes: ANOMALY_RULE_DEFAULTS.renotifyIntervalMinutes,
		apdexThresholdMs: null,
		queryBuilderDraftJson: null,
		rawQuerySql: null,
		destinationIdsJson: [...legacy.destinationIds],
		// The queryless plan of `MANAGED_RULE_PLAN`, spelled out to keep this module free of the model.
		querySpecJson: null,
		reducer: "identity",
		sampleCountStrategy: null,
		noDataBehavior: "skip",
	} as const
}
