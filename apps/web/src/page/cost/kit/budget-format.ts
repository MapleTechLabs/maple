import type { CostDimension, CostFilters } from "@maple/domain/cost"
import {
	type CostBudgetBasis,
	type CostBudgetPeriod,
	type CostBudgetProgress,
	costBudgetReachedTier,
} from "@maple/domain/cost-budget"
import type { AlertSeverity, CostBudget, CostBudgetAlert, CostSourceSummary } from "@maple/domain/http"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Array as Arr, Option } from "effect"
import { AppRoute, hrefOf } from "../../../route"
import { COST_GROUP_BYS, type CostBudgetNewSearch } from "../../../route/search"
import { DIMENSIONS, formatDay, formatMoney, keyLabel } from "../derive"

// A budget in words: what it covers, how much per period, where it stands and when it alerts. The
// list, the editor and the incident page all say it the same way.

export const ALL_SPEND = "All spend"

export const PERIODS = {
	month: { label: "Monthly", noun: "month" },
	quarter: { label: "Quarterly", noun: "quarter" },
	year: { label: "Yearly", noun: "year" },
} as const satisfies Record<CostBudgetPeriod, Readonly<{ label: string; noun: string }>>

/** Every dimension a budget can be narrowed by: the Cost page's, then the two only the API sets. */
export const BUDGET_DIMENSIONS: ReadonlyArray<CostDimension> = [...COST_GROUP_BYS, "usage_type", "service"]

const dimensionLabel = (dimension: CostDimension): string =>
	dimension === "usage_type"
		? "Usage type"
		: dimension === "service"
			? "Telemetry service"
			: DIMENSIONS[dimension].label

const valueLabel = (
	dimension: CostDimension,
	value: string,
	sources: ReadonlyArray<CostSourceSummary>,
): string =>
	dimension === "usage_type" || dimension === "service" ? value : keyLabel(dimension, value, sources)

/** One value of a budget's slice, as a chip or a line names it. */
type ScopeEntry = Readonly<{ dimension: CostDimension; value: string; label: string }>

/** Every value a budget is narrowed to, in the Cost page's dimension order; none covers all spend. */
export const scopeEntries = (
	filters: CostFilters,
	sources: ReadonlyArray<CostSourceSummary> = [],
): ReadonlyArray<ScopeEntry> =>
	Arr.flatMap(BUDGET_DIMENSIONS, (dimension) =>
		Arr.map(filters[dimension] ?? [], (value) => ({
			dimension,
			value,
			label: `${dimensionLabel(dimension)}: ${valueLabel(dimension, value, sources)}`,
		})),
	)

/** "Provider: AWS, Vercel · Region: us-east-1", or "All spend": a dimension is named once. */
export const scopeText = (filters: CostFilters, sources: ReadonlyArray<CostSourceSummary> = []): string => {
	const dimensions = Arr.flatMap(BUDGET_DIMENSIONS, (dimension) => {
		const values = filters[dimension] ?? []
		return values.length === 0
			? []
			: [
					`${dimensionLabel(dimension)}: ${Arr.join(
						Arr.map(values, (value) => valueLabel(dimension, value, sources)),
						", ",
					)}`,
				]
	})
	return dimensions.length === 0 ? ALL_SPEND : Arr.join(dimensions, " · ")
}

/** "$600.00 of $1,000.00". */
export const spentText = (budget: Pick<CostBudget, "amount" | "currency">, spent: number): string =>
	`${formatMoney(spent, budget.currency)} of ${formatMoney(budget.amount, budget.currency)}`

/** A share of a budget, rounded down: 99.6% must not read as reached before an alert opens on it. */
export const percentText = (percent: number): string => `${Math.floor(percent)}%`

/** "$1,200.00 by Nov 30", or null before the period has a forecast. */
export const forecastText = (
	budget: Pick<CostBudget, "currency">,
	progress: CostBudgetProgress,
): string | null =>
	progress.forecast === null
		? null
		: `${formatMoney(progress.forecast, budget.currency)} by ${formatDay(progress.periodEnd)}`

const BASIS_NOUN = { actual: "spend", forecast: "forecast" } as const satisfies Record<
	CostBudgetBasis,
	string
>

/** "100% forecast": what an alert opens at, without its severity. */
export const alertText = (alert: Pick<CostBudgetAlert, "percent" | "basis">): string =>
	`${alert.percent}% ${BASIS_NOUN[alert.basis]}`

/** The severity a budget stands at now, from its own alerts; null while none is reached. */
export const reachedSeverity = (
	budget: Pick<CostBudget, "alerts">,
	progress: CostBudgetProgress,
): AlertSeverity | null =>
	Option.match(costBudgetReachedTier(progress, budget.alerts), {
		onNone: () => null,
		onSome: (alert) => alert.severity,
	})

/** The API refused a write: the viewer does not hold `slos:manage`, or is an analyst. */
export const isForbidden = (failure: LoadFailure): boolean =>
	failure.code === "cost_budget_forbidden" || failure.code === "limited_role"

export const budgetsHref = (): string => hrefOf(AppRoute.CostBudgets())

/** The editor: empty, prefilled with a slice of spend, or on one budget (`budgetId`). */
export const budgetFormHref = (search: CostBudgetNewSearch = {}): string =>
	hrefOf(AppRoute.CostBudgetNew({ search }))
