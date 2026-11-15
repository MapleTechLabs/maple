// The hidden `cost_budget` alert rule behind each cost budget: its columns, how its row reads
// back, and what one check of it observes.
import type { AlertEvaluation } from "@maple/alerting-core"
import {
	type CostBudgetBasis,
	type CostBudgetPeriod,
	type CostBudgetProgress,
	type CostBudgetTier,
	StoredCostBudget,
	costBudgetObserved,
	costBudgetPeriodWindow,
	costBudgetReachedTier,
	costBudgetTierStatus,
} from "@maple/domain/cost-budget"
import {
	AlertThresholds,
	type AlertRuleId,
	type CostBudget,
	type CostBudgetAlert,
	type CostBudgetDefinition,
	alertThresholdLegacyFields,
	sortAlertThresholds,
} from "@maple/domain/http"
import { Array as Arr, Option, Schema } from "effect"
import { MANAGED_RULE_PLAN } from "@maple/backend/services/alerts/AlertRuleModel"

/** The rule's tiers, lowest severity first: one per alert, at its percent of the amount. */
const thresholdsOf = (alerts: Arr.NonEmptyReadonlyArray<CostBudgetAlert>): AlertThresholds =>
	sortAlertThresholds(
		Arr.map(alerts, (alert) => ({
			severity: alert.severity,
			value: alert.percent,
			upper: null,
			recoveryValue: null,
			destinationIds: [...alert.destinationIds],
		})),
	)

/**
 * The `alert_rules` columns of a budget's rule: a tier per alert, checked hourly (cost is synced
 * about once a day). One check decides: the period to date is already a sum, and a forecast
 * tier has its own band. A day between reminders keeps a spent budget from notifying all day.
 */
export const costBudgetRuleFields = (input: CostBudgetDefinition) => {
	const thresholds = thresholdsOf(input.alerts)
	const legacy = alertThresholdLegacyFields(thresholds)
	const stored: StoredCostBudget = {
		amount: input.amount,
		currency: input.currency,
		period: input.period,
		metric: input.metric,
		filters: input.filters,
		forecastSeverities: Arr.map(
			Arr.filter(input.alerts, (alert) => alert.basis === "forecast"),
			(alert) => alert.severity,
		),
	}
	return {
		name: input.name,
		notes: null,
		notificationTemplateJson: null,
		enabled: input.enabled,
		severity: legacy.severity,
		serviceNamesJson: null,
		excludeServiceNamesJson: null,
		environmentsJson: null,
		costBudgetJson: stored,
		tagsJson: null,
		groupBy: null,
		signalType: "cost_budget",
		comparator: "gte",
		threshold: legacy.threshold,
		thresholdUpper: null,
		thresholdsJson: thresholds,
		// A placeholder: a check reads the period to date, and notifications name the period instead.
		windowMinutes: 1440,
		evaluationIntervalMinutes: 60,
		slowedIntervalMinutes: null,
		slowedAt: null,
		minimumSampleCount: 0,
		consecutiveBreachesRequired: 1,
		breachesOutOf: null,
		consecutiveHealthyRequired: 1,
		renotifyIntervalMinutes: 1440,
		apdexThresholdMs: null,
		queryBuilderDraftJson: null,
		rawQuerySql: null,
		destinationIdsJson: [...legacy.destinationIds],
		querySpecJson: null,
		reducer: MANAGED_RULE_PLAN.reducer,
		sampleCountStrategy: null,
		noDataBehavior: MANAGED_RULE_PLAN.noDataBehavior,
	} as const
}

/** The columns a budget reads back from; the jsonb ones undecoded, so one bad row fails alone. */
export interface CostBudgetRuleRow {
	readonly id: AlertRuleId
	readonly name: string
	readonly enabled: boolean
	readonly costBudgetJson: unknown
	readonly thresholdsJson: unknown
	readonly createdAt: number
	readonly updatedAt: number
}

const decodeStored = Schema.decodeUnknownOption(StoredCostBudget)
const decodeThresholds = Schema.decodeUnknownOption(AlertThresholds)

const basisOf = (stored: StoredCostBudget, severity: CostBudgetAlert["severity"]): CostBudgetBasis =>
	Arr.contains(stored.forecastSeverities, severity) ? "forecast" : "actual"

/**
 * A stored rule as the budget it is. None when its tiers or its budget do not read: showing a
 * guess would let a save overwrite what is stored.
 */
export const costBudgetFromRow = (row: CostBudgetRuleRow): Option.Option<CostBudget> =>
	Option.all({
		stored: decodeStored(row.costBudgetJson),
		thresholds: decodeThresholds(row.thresholdsJson),
	}).pipe(
		Option.map(({ stored, thresholds }) => ({
			id: row.id,
			name: row.name,
			enabled: row.enabled,
			amount: stored.amount,
			currency: stored.currency,
			period: stored.period,
			metric: stored.metric,
			filters: stored.filters,
			alerts: Arr.map(sortAlertThresholds(thresholds), (tier) => ({
				severity: tier.severity,
				percent: tier.value,
				basis: basisOf(stored, tier.severity),
				destinationIds: tier.destinationIds,
			})),
			createdAt: row.createdAt,
			updatedAt: row.updatedAt,
		})),
	)

const PERIOD_ADJECTIVE = {
	month: "monthly",
	quarter: "quarterly",
	year: "yearly",
} as const satisfies Record<CostBudgetPeriod, string>

const formatMoney = (amount: number, currency: string): string =>
	new Intl.NumberFormat("en-US", { style: "currency", currency }).format(amount)

const formatPercent = (percent: number): string => `${Math.round(percent)}%`

/** What one check of a budget saw, as the incident and its notifications say it. */
export const costBudgetReason = (
	budget: StoredCostBudget,
	progress: CostBudgetProgress,
	basis: CostBudgetBasis,
): string => {
	const money = (amount: number) => formatMoney(amount, budget.currency)
	const of = `of the ${money(budget.amount)} ${PERIOD_ADJECTIVE[budget.period]} budget`
	const spent = `${money(progress.spent)} ${of} (${formatPercent(progress.percent)})`
	if (basis === "forecast" && progress.forecast !== null && progress.forecastPercent !== null) {
		return `Forecast to spend ${money(progress.forecast)} ${of} (${formatPercent(progress.forecastPercent)}) by ${progress.periodEnd}; ${money(progress.spent)} spent so far`
	}
	return progress.forecast === null
		? `Spent ${spent}`
		: `Spent ${spent}; forecast ${money(progress.forecast)} by ${progress.periodEnd}`
}

/**
 * One check of a budget's rule. Each tier is judged on what it watches (spend so far or the
 * forecast), so the levels are set here rather than by comparing one value to every tier. The
 * value is the percent the most severe reached tier watches, else the percent spent.
 */
export const evaluateCostBudget = (
	budget: StoredCostBudget,
	thresholds: AlertThresholds,
	progress: CostBudgetProgress,
): AlertEvaluation => {
	const tiers: ReadonlyArray<CostBudgetTier> = Arr.map(thresholds, (tier) => ({
		severity: tier.severity,
		percent: tier.value,
		basis: basisOf(budget, tier.severity),
	}))
	const reached = costBudgetReachedTier(progress, tiers)
	const basis = Option.match(reached, { onNone: () => "actual" as const, onSome: (tier) => tier.basis })
	return {
		status: Option.isSome(reached) ? "breached" : "healthy",
		value: costBudgetObserved(progress, basis) ?? progress.percent,
		sampleCount: progress.elapsedDays,
		threshold: alertThresholdLegacyFields(thresholds).threshold,
		thresholdUpper: null,
		comparator: "gte",
		derivedFromNoData: false,
		levels: Arr.map(tiers, (tier) => ({
			severity: tier.severity,
			status: costBudgetTierStatus(progress, tier),
		})),
		reason: costBudgetReason(budget, progress, basis),
	}
}

/**
 * A breach seen while an incident from an earlier period is still open (no check ran in between).
 * That incident is about a period that is over: this check reads as recovered and closes it, and
 * the next one judges the new period and opens its own incident, with its own notification.
 */
export const closeLastPeriod = <Evaluation extends AlertEvaluation>(
	budget: StoredCostBudget,
	evaluation: Evaluation,
	incidentOpenedAtMs: number | null,
	nowMs: number,
): Evaluation =>
	incidentOpenedAtMs === null ||
	evaluation.status !== "breached" ||
	incidentOpenedAtMs >= costBudgetPeriodWindow(budget.period, nowMs).startMs
		? evaluation
		: {
				...evaluation,
				status: "healthy",
				levels: Arr.map(evaluation.levels ?? [], (level) => ({ ...level, status: "clear" as const })),
				reason: `A new ${budget.period} started. ${evaluation.reason}`,
			}
