// A cost budget: an amount per calendar period over a slice of the org's spend. Its alerts are
// the tiers of a hidden `cost_budget` alert rule, so this is what the rule stores and measures.
import { Array as Arr, DateTime, Number as Num, Option, Order, Schema } from "effect"
import { AlertSeverity } from "./alerts"
import { CostCurrency, CostFilters, CostMetric } from "./cost"

/** The calendar period a budget's amount is for, in UTC. */
export const CostBudgetPeriod = Schema.Literals(["month", "quarter", "year"])
export type CostBudgetPeriod = typeof CostBudgetPeriod.Type

/** What an alert compares to its percent: spend so far, or the period's projected total. */
export const CostBudgetBasis = Schema.Literals(["actual", "forecast"])
export type CostBudgetBasis = typeof CostBudgetBasis.Type

export const CostBudgetAmount = Schema.Number.check(
	Schema.isFinite(),
	Schema.isGreaterThan(0),
	Schema.isLessThanOrEqualTo(1_000_000_000_000),
)

/**
 * What a budget's rule stores beside its tiers. A tier's percent and destinations are the
 * rule's own thresholds; only which tiers watch the forecast is kept here.
 */
export const StoredCostBudget = Schema.Struct({
	amount: CostBudgetAmount,
	currency: CostCurrency,
	period: CostBudgetPeriod,
	metric: CostMetric,
	filters: CostFilters,
	forecastSeverities: Schema.Array(AlertSeverity),
})
export type StoredCostBudget = typeof StoredCostBudget.Type

/** A run rate over fewer days than this says little: no forecast is made before. */
export const COST_BUDGET_FORECAST_MIN_DAYS = 3

/** Where a budget stands in its current period. Days are `YYYY-MM-DD` in UTC. */
export const CostBudgetProgress = Schema.Struct({
	periodStart: Schema.String,
	periodEnd: Schema.String,
	periodDays: Schema.Number,
	/** The days of the period the forecast's run rate is taken over. */
	elapsedDays: Schema.Number,
	spent: Schema.Number,
	/** The period's projected total; null until `COST_BUDGET_FORECAST_MIN_DAYS` of it have passed. */
	forecast: Schema.NullOr(Schema.Number),
	/** `spent` as a percent of the amount. */
	percent: Schema.Number,
	forecastPercent: Schema.NullOr(Schema.Number),
})
export type CostBudgetProgress = typeof CostBudgetProgress.Type

const DAY_MS = 86_400_000

const dayOfMs = (epochMs: number): string => DateTime.formatIsoDateUtc(DateTime.makeUnsafe(epochMs))

const PERIOD_MONTHS = { month: 1, quarter: 3, year: 12 } as const satisfies Record<CostBudgetPeriod, number>

/** The period `nowMs` is in: its first and last day, and how many days it has. */
export const costBudgetPeriodWindow = (period: CostBudgetPeriod, nowMs: number) => {
	const now = DateTime.toPartsUtc(DateTime.makeUnsafe(nowMs))
	const months = PERIOD_MONTHS[period]
	// Parts count months from 1; `Date.UTC` from 0.
	const firstMonth = now.month - 1 - ((now.month - 1) % months)
	const startMs = Date.UTC(now.year, firstMonth, 1)
	const lastDayMs = Date.UTC(now.year, firstMonth + months, 1) - DAY_MS
	return {
		startMs,
		startDay: dayOfMs(startMs),
		endDay: dayOfMs(lastDayMs),
		days: Math.round((lastDayMs - startMs) / DAY_MS) + 1,
	}
}

/** Days a provider's newest cost may trail today before the forecast reads the gap as no spend. */
const FORECAST_LAG_DAYS = 2

/**
 * A budget's progress from its daily spend. Days outside the current period are left out. The
 * forecast is a straight run rate over the period's complete days, times the days of the period.
 */
export const costBudgetProgress = (
	budget: Pick<StoredCostBudget, "amount" | "period">,
	nowMs: number,
	days: ReadonlyArray<{ readonly day: string; readonly cost: number }>,
): CostBudgetProgress => {
	const window = costBudgetPeriodWindow(budget.period, nowMs)
	const today = dayOfMs(nowMs)
	const inPeriod = Arr.filter(days, (row) => row.day >= window.startDay && row.day <= window.endDay)
	const spent = Num.sumAll(Arr.map(inPeriod, (row) => row.cost))
	// Today is still filling: its cost is spent, but it is no day of the run rate.
	const complete = Arr.filter(inPeriod, (row) => row.day < today)
	const completedDays = Math.floor((nowMs - window.startMs) / DAY_MS)
	const throughNewest = Option.match(
		Arr.last(
			Arr.sort(
				Arr.map(complete, (row) => row.day),
				Order.String,
			),
		),
		{
			onNone: () => 0,
			onSome: (day) =>
				Math.round((DateTime.toEpochMillis(DateTime.makeUnsafe(day)) - window.startMs) / DAY_MS) + 1,
		},
	)
	// A provider reports a day late or two: the rate runs through the newest day with cost, so
	// a day not in yet does not read as a day without spend. Past that lag, an empty day is one.
	const elapsedDays = Math.min(completedDays, Math.max(throughNewest, completedDays - FORECAST_LAG_DAYS))
	const forecast =
		elapsedDays < COST_BUDGET_FORECAST_MIN_DAYS
			? null
			: Math.max(spent, (Num.sumAll(Arr.map(complete, (row) => row.cost)) / elapsedDays) * window.days)
	// Times a hundred first: 1100 of 1000 is then 110 and not 110.00000000000001.
	const percentOf = (money: number) => (money * 100) / budget.amount
	return {
		periodStart: window.startDay,
		periodEnd: window.endDay,
		periodDays: window.days,
		elapsedDays,
		spent,
		forecast,
		percent: percentOf(spent),
		forecastPercent: forecast === null ? null : percentOf(forecast),
	}
}

/** One alert of a budget, as far as judging it goes. */
export interface CostBudgetTier {
	readonly severity: AlertSeverity
	readonly percent: number
	readonly basis: CostBudgetBasis
}

/** The percent a tier compares to its own; null while it watches a forecast not made yet. */
export const costBudgetObserved = (progress: CostBudgetProgress, basis: CostBudgetBasis): number | null =>
	basis === "forecast" ? progress.forecastPercent : progress.percent

/** How far under its percent a forecast must fall before its tier clears: a run rate moves daily. */
const FORECAST_RECOVERY = 0.95

/**
 * Where a tier stands: reached, clear, or (a forecast just under its percent) held as it was.
 * A forecast not made yet is clear, so a new period ends what the last one opened.
 */
export const costBudgetTierStatus = (
	progress: CostBudgetProgress,
	tier: CostBudgetTier,
): "breach" | "hold" | "clear" => {
	const observed = costBudgetObserved(progress, tier.basis)
	if (observed === null) return "clear"
	if (observed >= tier.percent) return "breach"
	return tier.basis === "forecast" && observed >= tier.percent * FORECAST_RECOVERY ? "hold" : "clear"
}

const criticalFirst: Order.Order<CostBudgetTier> = Order.mapInput(Order.Number, (tier) =>
	tier.severity === "critical" ? 0 : 1,
)

/** The most severe tier that is reached, if any. */
export const costBudgetReachedTier = <Tier extends CostBudgetTier>(
	progress: CostBudgetProgress,
	tiers: ReadonlyArray<Tier>,
): Option.Option<Tier> =>
	Arr.findFirst(Arr.sort(tiers, criticalFirst), (tier) => costBudgetTierStatus(progress, tier) === "breach")
