import type { DashboardDocument } from "@maple/domain/http"
import {
	ALL_VALUE,
	dashboardVariableOptionsQuery,
	resolveDashboardVariableValue,
	type VariableValues,
} from "@maple/query-engine"
import { getLogsFacetValues } from "@maple/web-data/warehouse/logs"
import { getMetricAttributeValues } from "@maple/web-data/warehouse/metrics"
import {
	getResourceAttributeValues,
	getSpanAttributeValues,
	getTracesFacetValues,
} from "@maple/web-data/warehouse/traces"
import { Effect, Option, Array as Arr, Record as Rec } from "effect"
import { AsyncData } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import type { WidgetFailure } from "./widget-data"

// The dashboard variables: the
// option list each variable reads, and the value it resolves to from the URL, its default or the list.

export type Variable = NonNullable<DashboardDocument["variables"]>[number]

/** A variable's option list: custom options are inline; query variables fetch for the window. */
export type OptionsSource =
	| Readonly<{ _tag: "Inline"; options: ReadonlyArray<string> }>
	| Readonly<{ _tag: "Query"; key: string }>
	| Readonly<{ _tag: "None" }>

type Window = Readonly<{ startTime: string; endTime: string }>

const names = (rows: ReadonlyArray<{ readonly name: string }>) => Arr.map(rows, (row) => row.name)
const values = (rows: ReadonlyArray<{ readonly attributeValue: string }>) =>
	Arr.map(rows, (row) => row.attributeValue)

/** `readVariableOptions`'s request for one variable, keyed so a window change refetches. */
export const optionsSourceOf = (orgId: string, variable: Variable, window: Window | null): OptionsSource => {
	if (variable.type === "custom")
		return { _tag: "Inline", options: Arr.map(variable.options, (option) => option.value) }
	const query = dashboardVariableOptionsQuery(variable)
	if (query === null || window === null) return { _tag: "None" }
	return { _tag: "Query", key: requestKey(orgId, "dashboardVariableOptions", { query, window }) }
}

/** The option strings a query variable reads (`readVariableOptions`' server functions). */
export const fetchVariableOptions = (variable: Variable, window: Window) => {
	const query = dashboardVariableOptionsQuery(variable)
	if (query === null) return Effect.succeed<ReadonlyArray<string>>([])
	if (query.kind === "attributeValues") {
		const data = { ...window, attributeKey: query.attributeKey }
		return query.source === "metrics"
			? Effect.map(
					getMetricAttributeValues({
						data: {
							...data,
							metricNames: query.metricNames,
							metricType: query.metricType,
							scope: query.scope === "resource" ? "resource" : "metric",
						},
					}),
					(response) => values(response.data),
				)
			: query.scope === "resource"
				? Effect.map(getResourceAttributeValues({ data }), (response) => values(response.data))
				: Effect.map(getSpanAttributeValues({ data }), (response) => values(response.data))
	}
	return query.source === "logs"
		? Effect.map(
				getLogsFacetValues({ data: { ...window, facet: query.facet ?? "severity" } }),
				(response) => names(response.data),
			)
		: Effect.map(
				getTracesFacetValues({ data: { ...window, facet: query.facet ?? "service" } }),
				(response) => names(response.data),
			)
}

/** A variable's option list; `error` says why a query variable has none it could read. */
export type OptionsState = Readonly<{
	options: ReadonlyArray<string>
	loading: boolean
	error: string | null
}>

export const NO_OPTIONS: OptionsState = { options: [], loading: false, error: null }

/** A query variable whose options failed: its empty fallback is no value. */
const isUnavailable = (variable: Variable, options: OptionsState, value: string | undefined) =>
	variable.type === "query" && options.error !== null && value === ""

/** "All" over failed options: fine where it drops a where clause, no value where it expands to the options. */
const isUnexpandable = (variable: Variable, options: OptionsState, value: string | undefined) =>
	variable.type === "query" && options.error !== null && value === ALL_VALUE

/** `values`: each variable's resolved value; one waiting on (or failed by) its options is absent. */
export const resolveVariableValues = (
	variables: ReadonlyArray<Variable>,
	urlValues: Readonly<Record<string, string>>,
	optionsByName: Readonly<Record<string, OptionsState>>,
): VariableValues =>
	Rec.fromEntries(
		Arr.flatMap(variables, (variable) => {
			const options = optionsByName[variable.name] ?? NO_OPTIONS
			const value = resolveDashboardVariableValue(variable, urlValues[variable.name], options)
			return value === undefined || isUnavailable(variable, options, value)
				? []
				: [[variable.name, { value, isAll: value === ALL_VALUE, options: [...options.options] }]]
		}),
	)

/** The variables no value can come from, by name, with why: tiles reading them cannot run. */
export const unavailableVariables = (
	variables: ReadonlyArray<Variable>,
	urlValues: Readonly<Record<string, string>>,
	optionsByName: Readonly<Record<string, OptionsState>>,
): Readonly<Record<string, string>> =>
	Rec.fromEntries(
		Arr.flatMap(variables, (variable) => {
			const options = optionsByName[variable.name] ?? NO_OPTIONS
			const value = resolveDashboardVariableValue(variable, urlValues[variable.name], options)
			return isUnavailable(variable, options, value) && options.error !== null
				? [[variable.name, options.error]]
				: []
		}),
	)

/** Variables set to "All" whose options failed, with why: tiles expanding them (SQL) cannot run. */
export const unexpandableVariables = (
	variables: ReadonlyArray<Variable>,
	urlValues: Readonly<Record<string, string>>,
	optionsByName: Readonly<Record<string, OptionsState>>,
): Readonly<Record<string, string>> =>
	Rec.fromEntries(
		Arr.flatMap(variables, (variable) => {
			const options = optionsByName[variable.name] ?? NO_OPTIONS
			const value = resolveDashboardVariableValue(variable, urlValues[variable.name], options)
			return isUnexpandable(variable, options, value) && options.error !== null
				? [[variable.name, options.error]]
				: []
		}),
	)

// OPTION SLOTS

/** Each query variable's fetched option list, by variable name. */
export type OptionsSlots = Readonly<Record<string, Keyed.Keyed<ReadonlyArray<string>, WidgetFailure>>>
export type OptionsRequest = Readonly<{ name: string; key: string; variable: Variable; window: Window }>
type OptionsPlan = Readonly<{ slots: OptionsSlots; requests: ReadonlyArray<OptionsRequest> }>

/** Asks for every query variable's option list for the window; a held fresh key is not asked again. */
export const planOptionRequests = (
	orgId: string,
	variables: ReadonlyArray<Variable>,
	slots: OptionsSlots,
	window: Window | null,
	mode: Keyed.RequestMode,
): OptionsPlan => {
	const initial: OptionsPlan = { slots, requests: [] }
	return Arr.reduce(variables, initial, (state, variable) => {
		const source = optionsSourceOf(orgId, variable, window)
		if (source._tag !== "Query" || window === null) return state
		return Option.match(Keyed.request(state.slots[variable.name] ?? Keyed.idle(), source.key, mode), {
			onNone: () => state,
			onSome: (next) => ({
				slots: { ...state.slots, [variable.name]: next },
				requests: [...state.requests, { name: variable.name, key: source.key, variable, window }],
			}),
		})
	})
}

/** `optionsByName`: inline lists, fetched lists, and the loading state of the rest. */
export const optionsByNameOf = (
	orgId: string,
	variables: ReadonlyArray<Variable>,
	slots: OptionsSlots,
	window: Window | null,
): Record<string, OptionsState> =>
	Rec.fromEntries(
		Arr.map(variables, (variable) => {
			const source = optionsSourceOf(orgId, variable, window)
			if (source._tag === "Inline") return [variable.name, { ...NO_OPTIONS, options: source.options }]
			if (source._tag === "None" && variable.type === "query")
				return [
					variable.name,
					window === null
						? { ...NO_OPTIONS, loading: true }
						: { ...NO_OPTIONS, error: "This variable has no options query" },
				]
			if (source._tag === "None") return [variable.name, NO_OPTIONS]
			const slot = slots[variable.name]
			const data = slot === undefined || slot.key !== source.key ? AsyncData.Idle() : slot.data
			const state: OptionsState = AsyncData.match(data, {
				onIdle: () => ({ ...NO_OPTIONS, loading: true }),
				onLoading: () => ({ ...NO_OPTIONS, loading: true }),
				onFailure: (failure) => ({ ...NO_OPTIONS, error: failure.message }),
				onSuccess: (options) => ({ ...NO_OPTIONS, options }),
				onRefreshing: (options) => ({ ...NO_OPTIONS, options, loading: true }),
				onStale: ({ data: options }) => ({ ...NO_OPTIONS, options }),
			})
			return [variable.name, state]
		}),
	)

/** The board's variables as a tile plans with them: their names and resolved values. */
export const planVariablesOf = (
	orgId: string,
	variables: ReadonlyArray<Variable>,
	urlValues: Readonly<Record<string, string>>,
	slots: OptionsSlots,
	window: Window | null,
) => {
	const optionsByName = optionsByNameOf(orgId, variables, slots, window)
	return {
		names: Arr.map(variables, (variable) => variable.name),
		values: resolveVariableValues(variables, urlValues, optionsByName),
		unavailable: unavailableVariables(variables, urlValues, optionsByName),
		unexpandable: unexpandableVariables(variables, urlValues, optionsByName),
	}
}
