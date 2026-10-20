import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { PageContext } from "../../contract"
import { type AutocompleteLookup, lookupField, type LookupNames } from "../../kit/autocomplete-lookups"
import type { QueryDraft } from "../../kit/query-builder/draft"
import type { PanelInputs } from "../../kit/query-builder/panel"
import type { Model } from "./model"
import { autocompleteWindowOf } from "./update"

// `useWidgetBuilderData`'s `autocompleteValues`: the provider's lookups per source, the metric
// list's services, and the board's variable names, for the query panels' where editors.

const answerOf = (model: Model, lookup: AutocompleteLookup): LookupNames | undefined =>
	Option.getOrUndefined(AsyncData.getData(model.autocomplete[lookup]?.data ?? AsyncData.Idle()))

const field = (model: Model, lookup: AutocompleteLookup, name: string): Array<string> => [
	...lookupField(answerOf(model, lookup), name),
]

/** `AutocompleteValuesProvider`'s values for a source the list widget reads (no variables). */
export const providerValuesOf = (
	model: Model,
	dataSource: "traces" | "logs" | "product_events",
): WhereClauseAutocompleteValues => {
	const spanKeys = field(model, "spanAttributeKeys", "keys")
	const resourceKeys = field(model, "resourceAttributeKeys", "keys")
	switch (dataSource) {
		case "traces":
			return {
				services: field(model, "tracesFacets", "services"),
				spanNames: field(model, "tracesFacets", "spanNames"),
				environments: field(model, "tracesFacets", "environments"),
				httpMethods: field(model, "tracesFacets", "httpMethods"),
				httpStatusCodes: field(model, "tracesFacets", "httpStatusCodes"),
				attributeKeys: spanKeys,
				resourceAttributeKeys: resourceKeys,
			}
		case "logs":
			return {
				services: field(model, "logsFacets", "services"),
				severities: field(model, "logsFacets", "severities"),
				attributeKeys: spanKeys,
				resourceAttributeKeys: resourceKeys,
			}
		case "product_events":
			return {
				eventNames: field(model, "productEventNames", "keys"),
				attributeKeys: field(model, "productEventAttributeKeys", "keys"),
			}
	}
}

/** `autocompleteValues[query.dataSource]`, with a picked metric's own keys (`useMetricScopedAutocomplete`). */
export const baseValuesOf = (model: Model, query: QueryDraft): WhereClauseAutocompleteValues => {
	const variables = (model.document?.variables ?? []).map((variable) => variable.name)
	switch (query.dataSource) {
		case "traces":
		case "logs":
		case "product_events":
			return { ...providerValuesOf(model, query.dataSource), variables }
		case "metrics": {
			const isScoped = query.metricName !== ""
			return {
				metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
				attributeKeys: isScoped
					? [...(model.metricKeys[`${query.metricName}::${query.metricType}`] ?? [])]
					: field(model, "metricAttributeKeys", "keys"),
				services: [...(model.metricOptions?.services ?? [])],
				variables,
			}
		}
	}
}

export const panelInputsOf = (model: Model, context: PageContext): PanelInputs => ({
	queryOf: (queryId) => model.state?.queries.find((query) => query.id === queryId),
	baseValuesOf: (query) => baseValuesOf(model, query),
	orgId: context.orgId,
	window: autocompleteWindowOf(model, context),
})
