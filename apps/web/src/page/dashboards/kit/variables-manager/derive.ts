import { DashboardVariableName } from "@maple/domain/http"
import { QUERY_BUILDER_METRIC_TYPES, type QueryBuilderMetricType } from "@maple/query-model"
import { Schema } from "effect"
import type { Variable } from "./model"

// The pure half of `VariablesManagerDialog`: labels, summaries, retyping and per-draft validation.

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

/** `sourceSummary`: the row's second line. */
export const sourceSummary = (variable: Variable): string => {
	if (variable.type === "custom") {
		const listed = variable.options.map((option) => option.value).join(", ")
		return listed === "" ? "No options" : listed
	}
	if (variable.type === "textbox") return "Free text"
	const source = variable.source
	switch (source.kind) {
		case "facet":
			return FACET_LABELS[source.facet]
		case "attribute":
			return `${source.scope} attribute: ${source.attributeKey === "" ? "…" : source.attributeKey}`
		case "metric":
			return `metric ${source.scope} attribute: ${source.attributeKey === "" ? "…" : source.attributeKey} (${source.metricNames.length === 1 ? source.metricNames[0] : `${source.metricNames.length} metrics`})`
	}
}

export const newVariable = (): Variable => ({
	name: "",
	type: "query",
	source: { kind: "facet", facet: "service" },
})

/** `withType`: retyped, keeping the shared base fields. */
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

/** `draftError`: the first problem with a draft, computed live. */
export const draftError = (
	draft: Variable,
	index: number,
	drafts: ReadonlyArray<Variable>,
): string | null => {
	if (draft.name === "") return "Name is required."
	if (!isValidVariableName(draft.name))
		return "Names start with a letter, then letters, digits, or underscores."
	if (drafts.some((other, i) => i !== index && other.name === draft.name))
		return `Another variable is already named "${draft.name}".`
	if (draft.type === "query" && draft.source.kind !== "facet" && draft.source.attributeKey.trim() === "")
		return "Pick the attribute key to list values for."
	if (draft.type === "query" && draft.source.kind === "metric") {
		if (draft.source.metricNames.some((name) => name === ""))
			return "Name at least one metric to list values from."
		if (draft.source.metricNames.length > 20) return "List at most 20 metrics."
	}
	return null
}

/** The "Values from" select's value for a query source. */
export const sourceValueOf = (variable: QueryVariable): string =>
	variable.source.kind === "facet"
		? `facet:${variable.source.facet}`
		: `${variable.source.kind}:${variable.source.scope}`

/** The "Values from" pick applied to a query variable. */
export const withSourceValue = (variable: QueryVariable, value: string): Variable => {
	const [kind, detail] = value.split(":")
	const source = variable.source
	const attributeKey = source.kind === "facet" ? "" : source.attributeKey
	const facet = FACETS.find((candidate) => candidate === detail)
	if (kind === "facet" && facet !== undefined) return { ...variable, source: { kind: "facet", facet } }
	if (kind === "attribute" && (detail === "span" || detail === "resource"))
		return { ...variable, source: { kind: "attribute", scope: detail, attributeKey } }
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
	...FACETS.map((facet) => ({ value: `facet:${facet}`, label: FACET_LABELS[facet] })),
	{ value: "attribute:span", label: "Span attribute…" },
	{ value: "attribute:resource", label: "Resource attribute…" },
	{ value: "metric:metric", label: "Metric attribute…" },
	{ value: "metric:resource", label: "Metric resource attribute…" },
]
