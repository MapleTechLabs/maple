import { DashboardVariableName, PromqlVariableLabel, PromqlVariableMatch } from "@maple/domain/http"
import { QUERY_BUILDER_METRIC_TYPES, type QueryBuilderMetricType } from "@maple/query-model"
import { Schema, Array as Arr, String as Str, Option } from "effect"
import type { Variable } from "./model"

const isValidVariableName = Schema.is(DashboardVariableName)

type QueryVariable = Extract<Variable, { type: "query" }>
export type QueryFacet = Extract<QueryVariable["source"], { kind: "facet" }>["facet"]

export const FACET_LABELS = {
	service: "Service",
	environment: "Environment",
	span_name: "Span name",
	http_method: "HTTP method",
	http_status_code: "HTTP status code",
	log_severity: "Log severity",
} satisfies Record<QueryFacet, string>

export const FACETS: ReadonlyArray<QueryFacet> = [
	"service",
	"environment",
	"span_name",
	"http_method",
	"http_status_code",
	"log_severity",
]

export const METRIC_TYPE_LABELS = {
	sum: "Sum",
	gauge: "Gauge",
	histogram: "Histogram",
	exponential_histogram: "Exponential histogram",
} satisfies Record<QueryBuilderMetricType, string>

export const METRIC_TYPES: ReadonlyArray<QueryBuilderMetricType> = QUERY_BUILDER_METRIC_TYPES

export const TYPE_LABELS = { query: "Query", custom: "Custom", textbox: "Textbox" } satisfies Record<
	Variable["type"],
	string
>

export const TYPE_OPTIONS = {
	query: "Query (from telemetry)",
	custom: "Custom (static list)",
	textbox: "Textbox (free text)",
} satisfies Record<Variable["type"], string>

export const VARIABLE_TYPES: ReadonlyArray<Variable["type"]> = ["query", "custom", "textbox"]

/** The row's second line. */
export const sourceSummary = (variable: Variable): string => {
	if (variable.type === "custom") {
		const listed = Arr.join(
			Arr.map(variable.options, (option) => option.value),
			", ",
		)
		return listed === "" ? "No options" : listed
	}
	if (variable.type === "textbox") return "Free text"
	const source = variable.source
	switch (source.kind) {
		case "facet":
			return FACET_LABELS[source.facet]
		case "attribute":
			return `${source.scope} attribute: ${source.attributeKey === "" ? "…" : source.attributeKey}`
		case "promql":
			return `Prometheus label: ${source.label === "" ? "…" : source.label}${source.match === undefined ? "" : ` of ${source.match}`}`
		case "metric":
			return `metric ${source.scope} attribute: ${source.attributeKey === "" ? "…" : source.attributeKey} (${source.metricNames.length === 1 ? source.metricNames[0] : `${source.metricNames.length} metrics`})`
	}
}

export const newVariable = (): Variable => ({
	name: "",
	type: "query",
	source: { kind: "facet", facet: "service" },
})

/** Retyped, keeping the shared base fields. */
export const withType = (variable: Variable, type: Variable["type"]): Variable => {
	const base = {
		name: variable.name,
		...(variable.label === undefined ? undefined : { label: variable.label }),
		...(variable.includeAll === undefined ? undefined : { includeAll: variable.includeAll }),
		...(variable.defaultValue === undefined ? undefined : { defaultValue: variable.defaultValue }),
	}
	switch (type) {
		case "query":
			return { ...base, type, source: { kind: "facet", facet: "service" } }
		case "custom":
			return { ...base, type, options: [] }
		case "textbox":
			return { ...base, type }
	}
}

type QuerySource = Extract<Variable, { type: "query" }>["source"]

/** The key a source lists values of: an attribute key, or a Prometheus label. */
export const sourceKeyOf = (source: QuerySource): string => {
	if (source.kind === "facet") return ""
	return source.kind === "promql" ? source.label : source.attributeKey
}

/** The first problem with a draft, computed live. */
export const draftError = (
	draft: Variable,
	index: number,
	drafts: ReadonlyArray<Variable>,
): string | null => {
	if (draft.name === "") return "Name is required."
	if (!isValidVariableName(draft.name))
		return "Names start with a letter, then letters, digits, or underscores."
	if (Arr.some(drafts, (other, i) => i !== index && other.name === draft.name))
		return `Another variable is already named "${draft.name}".`
	if (draft.type === "query" && draft.source.kind === "promql") {
		const { label, match } = draft.source
		if (label === "") return "Name the Prometheus label to list values for."
		if (!isPromqlLabel(label))
			return "Labels start with a letter or underscore, then letters, digits or underscores, up to 256 characters."
		if (match !== undefined && !isPromqlMatch(match))
			return "Keep the series selector to 4096 characters."
	}
	if (draft.type === "query" && draft.source.kind !== "facet" && Str.trim(sourceKeyOf(draft.source)) === "")
		return "Pick the attribute key to list values for."
	if (draft.type === "query" && draft.source.kind === "metric") {
		if (Arr.some(draft.source.metricNames, (name) => name === ""))
			return "Name at least one metric to list values from."
		if (draft.source.metricNames.length > 20) return "List at most 20 metrics."
	}
	return null
}

/** The "Values from" select's value for a query source. */
export const sourceValueOf = (variable: QueryVariable): string => {
	const source = variable.source
	if (source.kind === "facet") return `facet:${source.facet}`
	return source.kind === "promql" ? "promql:label" : `${source.kind}:${source.scope}`
}

/** The "Values from" pick applied to a query variable. */
export const withSourceValue = (variable: QueryVariable, value: string): Variable => {
	const [kind, detail] = Str.split(":")(value)
	const source = variable.source
	const attributeKey = sourceKeyOf(source)
	const facet = Arr.findFirst(FACETS, (candidate) => candidate === detail)
	if (kind === "facet" && Option.isSome(facet))
		return { ...variable, source: { kind: "facet", facet: facet.value } }
	if (kind === "attribute" && (detail === "span" || detail === "resource"))
		return { ...variable, source: { kind: "attribute", scope: detail, attributeKey } }
	if (kind === "promql")
		return {
			...variable,
			source: {
				kind: "promql",
				label: attributeKey,
				...(source.kind === "promql" && source.match !== undefined
					? { match: source.match }
					: undefined),
			},
		}
	if (kind === "metric" && (detail === "metric" || detail === "resource"))
		return {
			...variable,
			source: {
				kind: "metric",
				scope: detail,
				attributeKey,
				metricNames: source.kind === "metric" ? source.metricNames : [""],
				metricType: source.kind === "metric" ? source.metricType : "gauge",
			},
		}
	return variable
}

export const SOURCE_ITEMS: ReadonlyArray<{ readonly value: string; readonly label: string }> = [
	...Arr.map(FACETS, (facet) => ({ value: `facet:${facet}`, label: FACET_LABELS[facet] })),
	{ value: "attribute:span", label: "Span attribute…" },
	{ value: "attribute:resource", label: "Resource attribute…" },
	{ value: "metric:metric", label: "Metric attribute…" },
	{ value: "metric:resource", label: "Metric resource attribute…" },
	{ value: "promql:label", label: "Prometheus label…" },
]

const isPromqlLabel = Schema.is(PromqlVariableLabel)
const isPromqlMatch = Schema.is(PromqlVariableMatch)
