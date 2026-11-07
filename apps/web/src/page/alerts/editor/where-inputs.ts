import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "../../../lib/query-builder/where-clause-autocomplete"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import type { PageContext } from "../../contract"
import { type AutocompleteLookup, lookupField } from "../../kit/autocomplete-lookups"
import type { QueryDraft } from "../../kit/query-builder/draft"
import { metricValueOf } from "../../kit/query-builder/metric-options"
import type { MetricKeys } from "../../kit/query-builder/metrics-body"
import type { PanelInputs } from "../../kit/query-builder/panel"
import { traceFacetsOf } from "./derive-rows"
import type { Model } from "./model"

// `AlertQueryPanel`'s `autocompleteValues` (the provider is not lazy here): the where editor's
// suggestions per source, over the editor's 24h window.

const field = (
	model: Pick<Model, "autocomplete">,
	lookup: AutocompleteLookup,
	name: string,
): Array<string> => [
	...lookupField(
		Option.getOrUndefined(AsyncData.getData(model.autocomplete[lookup]?.data ?? AsyncData.Idle())),
		name,
	),
]

type ValuesModel = Pick<Model, "traceFacets" | "autocomplete" | "metricKeys" | "metricOptions">

/** The picked metric's own keys, once read; none for another source or before a metric is picked. */
export const metricKeysOf = (model: Pick<Model, "metricKeys">, query: QueryDraft): MetricKeys | undefined =>
	query.dataSource === "metrics" && query.metricName !== ""
		? model.metricKeys[metricValueOf(query)]
		: undefined

/** `autocompleteValues[query.dataSource]`, with a picked metric's own keys (`useMetricScopedAutocomplete`). */
export const baseValuesOf = (model: ValuesModel, query: QueryDraft): WhereClauseAutocompleteValues => {
	const facets = traceFacetsOf(model)
	const spanKeys = field(model, "spanAttributeKeys", "keys")
	const resourceKeys = field(model, "resourceAttributeKeys", "keys")
	switch (query.dataSource) {
		case "traces":
			return {
				services: [...facets.services],
				spanNames: [...facets.spanNames],
				environments: [...facets.environments],
				httpMethods: [...facets.httpMethods],
				httpStatusCodes: [...facets.httpStatusCodes],
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
		case "metrics":
			return {
				metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
				// The org-wide keys stand in until a picked metric's own keys arrive.
				attributeKeys: [
					...(metricKeysOf(model, query)?.attributes ??
						field(model, "metricAttributeKeys", "keys")),
				],
				services: [...(model.metricOptions?.services ?? [])],
			}
		case "product_events":
			return {
				eventNames: field(model, "productEventNames", "keys"),
				attributeKeys: field(model, "productEventAttributeKeys", "keys"),
			}
	}
}

export const panelInputsOf = (model: Model, context: PageContext): PanelInputs => ({
	queryOf: (queryId) =>
		model.form?.queryBuilderDraft.id === queryId ? model.form.queryBuilderDraft : undefined,
	baseValuesOf: (query) => baseValuesOf(model, query),
	orgId: context.orgId,
	window: model.autocompleteWindow,
})
