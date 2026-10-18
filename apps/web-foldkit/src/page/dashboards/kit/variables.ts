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
import { Effect } from "effect"
import { requestKey } from "../../../data/request-key"

// `DashboardVariablesProvider` (dashboard-builder/dashboard-variables-context.tsx), React-free: the
// option list each variable reads, and the value it resolves to from the URL, its default or the list.

export type Variable = NonNullable<DashboardDocument["variables"]>[number]

/** A variable's option list: custom options are inline; query variables fetch for the window. */
export type OptionsSource =
	| Readonly<{ _tag: "Inline"; options: ReadonlyArray<string> }>
	| Readonly<{ _tag: "Query"; key: string }>
	| Readonly<{ _tag: "None" }>

type Window = Readonly<{ startTime: string; endTime: string }>

const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name)
const values = (rows: ReadonlyArray<{ readonly attributeValue: string }>) => rows.map((row) => row.attributeValue)

/** `readVariableOptions`'s request for one variable, keyed so a window change refetches. */
export const optionsSourceOf = (orgId: string, variable: Variable, window: Window | null): OptionsSource => {
	if (variable.type === "custom") return { _tag: "Inline", options: variable.options.map((option) => option.value) }
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
		return (
				query.source === "metrics"
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
		)
	}
	return (
		query.source === "logs"
				? Effect.map(getLogsFacetValues({ data: { ...window, facet: query.facet ?? "severity" } }), (response) =>
						names(response.data),
					)
				: Effect.map(getTracesFacetValues({ data: { ...window, facet: query.facet ?? "service" } }), (response) =>
						names(response.data),
					)
	)
}

export type OptionsState = Readonly<{ options: ReadonlyArray<string>; loading: boolean }>

/** `values`: each variable's resolved value; one still waiting on its options is absent. */
export const resolveVariableValues = (
	variables: ReadonlyArray<Variable>,
	urlValues: Readonly<Record<string, string>>,
	optionsByName: Readonly<Record<string, OptionsState>>,
): VariableValues =>
	Object.fromEntries(
		variables.flatMap((variable) => {
			const options = optionsByName[variable.name] ?? { options: [], loading: false }
			const value = resolveDashboardVariableValue(variable, urlValues[variable.name], options)
			return value === undefined
				? []
				: [[variable.name, { value, isAll: value === ALL_VALUE, options: [...options.options] }]]
		}),
	)
