import type { CostFilters } from "@maple/domain/cost"
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
import { type CostGroupBy, DIMENSIONS, formatDay, formatMoney, keyLabel } from "../derive"

// A budget in words: what it covers, how much per period, where it stands and when it alerts. The
// list, the editor and the incident page all say it the same way.

export const ALL_SPEND = "All spend"

export const PERIODS = {
	month: { label: "Monthly", noun: "month" },
	quarter: { label: "Quarterly", noun: "quarter" },
	year: { label: "Yearly", noun: "year" },
} as const satisfies Record<CostBudgetPeriod, Readonly<{ label: string; noun: string }>>

/** One value of a budget's slice, as a chip or a line names it. */
export type ScopeEntry = Readonly<{ dimension: CostGroupBy; value: string; label: string }>

/** Every value a budget is narrowed to, in the Cost page's dimension order; none covers all spend. */
export const scopeEntries = (
	filters: CostFilters,
	sources: ReadonlyArray<CostSourceSummary> = [],
): ReadonlyArray<ScopeEntry> =>
	Arr.flatMap(COST_GROUP_BYS, (dimension) =>
		Arr.map(filters[dimension] ?? [], (value) => ({
			dimension,
			value,
			label: `${DIMENSIONS[dimension].label}: ${keyLabel(dimension, value, sources)}`,
		})),
	)

/** "Provider: AWS, Vercel · Region: us-east-1", or "All spend": a dimension is named once. */
export const scopeText = (filters: CostFilters): string => {
	const dimensions = Arr.flatMap(COST_GROUP_BYS, (dimension) => {
		const values = filters[dimension] ?? []
		return values.length === 0
			? []
			: [
					`${DIMENSIONS[dimension].label}: ${Arr.join(
						Arr.map(values, (value) => keyLabel(dimension, value)),
						", ",
					)}`,
				]
	})
	return dimensions.length === 0 ? ALL_SPEND : Arr.join(dimensions, " · ")
}

/** "$600.00 of $1,000.00". */
export const spentText = (budget: Pick<CostBudget, "amount" | "currency">, spent: number): string =>
	`${formatMoney(spent, budget.currency)} of ${formatMoney(budget.amount, budget.currency)}`

export const percentText = (percent: number): string => `${Math.round(percent)}%`

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
	`${percentText(alert.percent)} ${BASIS_NOUN[alert.basis]}`

/** The severity a budget stands at now, from its own alerts; null while none is reached. */
export const reachedSeverity = (
	budget: Pick<CostBudget, "alerts">,
	progress: CostBudgetProgress,
): AlertSeverity | null =>
	Option.match(costBudgetReachedTier(progress, budget.alerts), {
		onNone: () => null,
		onSome: (alert) => alert.severity,
	})

/** The API refused a write: the viewer does not hold `alerts:manage`. */
export const isForbidden = (failure: LoadFailure): boolean => failure.code === "cost_budget_forbidden"

export const budgetsHref = (): string => hrefOf(AppRoute.CostBudgets())

/** The editor: empty, prefilled with a slice of spend, or on one budget (`budgetId`). */
export const budgetFormHref = (search: CostBudgetNewSearch = {}): string =>
	hrefOf(AppRoute.CostBudgetNew({ search }))
