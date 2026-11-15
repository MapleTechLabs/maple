import { COST_FILTER_MAX_VALUE_LENGTH, COST_FILTER_MAX_VALUES, CostFilters } from "@maple/domain/cost"
import {
	type AlertSeverity,
	type CostBudget,
	CostBudgetAlert,
	CostBudgetCreateRequest,
} from "@maple/domain/http"
import { Array as Arr, Option, Record as Rec, Schema, String as Str } from "effect"
import { COST_GROUP_BYS, type CostBudgetNewSearch } from "../../../route/search"
import { type CostGroupBy, perDimension } from "../derive"
import { BUDGET_DIMENSIONS } from "../kit/budget-format"
import { type AlertForm, emptyForm, type Form, perScope, SEVERITIES } from "./form"
import type { FormOptions } from "./model"

// The request schema is the one source of the bounds: a field is valid when the API would take it.
const fields = CostBudgetCreateRequest.fields
const isName = Schema.is(fields.name)
const isAmount = Schema.is(fields.amount)
const isCurrency = Schema.is(fields.currency)
const isFilters = Schema.is(CostFilters)
const isPercent = Schema.is(CostBudgetAlert.fields.percent)
const isDestinationIds = Schema.is(CostBudgetAlert.fields.destinationIds)

const numberOf = (raw: string, isValid: (value: number) => boolean): Option.Option<number> => {
	const text = Str.trim(raw)
	// As a decimal keypad types it: "1000", "49.50", ".5", and "1." on the way to "1.5".
	const value = /^(?:\d+(?:\.\d*)?|\.\d+)$/u.test(text) ? Number(text) : Number.NaN
	return isValid(value) ? Option.some(value) : Option.none()
}

/** The amount typed, when it is a positive number the API takes. */
export const amountOf = (form: Form): Option.Option<number> => numberOf(form.amount, isAmount)

/** The percent typed for an alert, when the API takes it (1 to 1,000). */
export const percentOf = (alert: AlertForm): Option.Option<number> => numberOf(alert.percent, isPercent)

/** The slice of spend as a read and the API carry it: only the dimensions that name a value. */
export const filtersOf = (form: Form): CostFilters =>
	Rec.fromEntries(
		Arr.flatMap(BUDGET_DIMENSIONS, (dimension) => {
			const values = form.scope[dimension]
			return values.length === 0 ? [] : [[dimension, values] as const]
		}),
	)

/** The alerts that are on, lowest severity first. */
const alertsOn = (form: Form): ReadonlyArray<readonly [AlertSeverity, AlertForm]> =>
	Arr.filter(
		Arr.map(SEVERITIES, (severity) => [severity, form.alerts[severity]] as const),
		([, alert]) => alert.isOn,
	)

/** What is wrong with the amount as typed: missing or zero, over the API's cap, or not a number. */
const amountIssues = (form: Form): ReadonlyArray<string> => {
	if (Option.isSome(amountOf(form))) return []
	if (Option.isSome(numberOf(form.amount, (value) => value > 0))) {
		return ["Keep the amount to a trillion or less."]
	}
	return Str.trim(form.amount) === "" || Option.isSome(numberOf(form.amount, (value) => value === 0))
		? ["Set an amount above zero."]
		: ["Write the amount as a plain number, like 1000 or 49.50."]
}

/** What still blocks saving, one sentence each. The bounds are the request schema's. */
export const formIssues = (form: Form): ReadonlyArray<string> => {
	const name = Str.trim(form.name)
	const on = alertsOn(form)
	return [
		...(name === "" ? ["Name the budget."] : []),
		...(name !== "" && !isName(name) ? ["Keep the name to 120 characters."] : []),
		...amountIssues(form),
		// A link can prefill more than the API takes.
		...(isFilters(filtersOf(form))
			? []
			: [
					`Keep each filter to ${COST_FILTER_MAX_VALUES} values of at most ${COST_FILTER_MAX_VALUE_LENGTH} characters.`,
				]),
		...(isCurrency(form.currency) ? [] : ["Pick a currency."]),
		...(on.length === 0 ? ["Turn on at least one alert."] : []),
		...Arr.flatMap(on, ([severity, alert]) => [
			...(Option.isNone(percentOf(alert)) ? [`Set the ${severity} alert from 1% to 1,000%.`] : []),
			...(isDestinationIds(alert.destinationIds)
				? []
				: [`Notify at most 20 destinations on the ${severity} alert.`]),
		]),
	]
}

/** The create body, also sent whole on an edit: `filters` and `alerts` replace the stored ones. */
export const wirePayload = (form: Form): Option.Option<CostBudgetCreateRequest> => {
	const alerts = Arr.map(alertsOn(form), ([severity, alert]) => ({
		severity,
		percent: Option.getOrElse(percentOf(alert), () => 0),
		basis: alert.basis,
		destinationIds: alert.destinationIds,
	}))
	return Arr.isReadonlyArrayNonEmpty(alerts)
		? Option.some({
				name: Str.trim(form.name),
				enabled: form.enabled,
				amount: Option.getOrElse(amountOf(form), () => 0),
				currency: form.currency,
				period: form.period,
				metric: form.metric,
				filters: filtersOf(form),
				alerts,
			})
		: Option.none()
}

const alertFormOf = (budget: CostBudget, severity: AlertSeverity): AlertForm =>
	Option.match(
		Arr.findFirst(budget.alerts, (alert) => alert.severity === severity),
		{
			// An alert the budget does not have is off, at what a new budget would start it with.
			onNone: () => ({ ...emptyForm().alerts[severity], isOn: false }),
			onSome: (alert) => ({
				isOn: true,
				percent: String(alert.percent),
				basis: alert.basis,
				destinationIds: alert.destinationIds,
			}),
		},
	)

export const formFromBudget = (budget: CostBudget): Form => ({
	name: budget.name,
	amount: String(budget.amount),
	currency: budget.currency,
	period: budget.period,
	metric: budget.metric,
	scope: perScope((dimension) => budget.filters[dimension] ?? []),
	alerts: { warning: alertFormOf(budget, "warning"), critical: alertFormOf(budget, "critical") },
	enabled: budget.enabled,
})

/** The form a link prefills: a new budget over the slice of spend the Cost page was filtered to. */
export const formFromSearch = (search: CostBudgetNewSearch): Form =>
	emptyForm({ scope: { ...perScope(() => []), ...perDimension((dimension) => search[dimension] ?? []) } })

/** The currencies the form offers: the org's, then the form's own when the org is not billed in it. */
export const currencyChoices = (form: Form, options: FormOptions | null): ReadonlyArray<string> =>
	Arr.dedupe([...(options?.currencies ?? []), form.currency])

/** A scope menu item's value: its dimension and the value it adds. */
export const scopeItemValue = (dimension: CostGroupBy, value: string): string => `${dimension}:${value}`

const isDimension = (text: string): text is CostGroupBy => Arr.contains<string>(COST_GROUP_BYS, text)

/** The dimension and value a scope menu pick names. */
export const scopeItemOf = (
	picked: string,
): Option.Option<Readonly<{ dimension: CostGroupBy; value: string }>> =>
	Option.flatMap(Str.indexOf(":")(picked), (at) => {
		const dimension = Str.slice(0, at)(picked)
		return isDimension(dimension)
			? Option.some({ dimension, value: Str.slice(at + 1)(picked) })
			: Option.none()
	})
