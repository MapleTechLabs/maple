import { QUERY_BUILDER_METRIC_TYPES } from "@maple/query-model"
import type { WhereClauseAutocompleteValues } from "./where-clause-autocomplete"
import type { Keyed } from "@maple/views/data/keyed"
import type { LoadFailure } from "@maple/views/data/load-failure"
import { Option } from "effect"
import { AsyncData } from "foldkit"
import { type AutocompleteLookup, lookupField, type LookupNames } from "../autocomplete-lookups"
import type { QueryDraft } from "./draft"
import { metricValueOf } from "./metric-options"
import type { MetricKeys } from "./metrics-body"

// `autocompleteValues[query.dataSource]` for every host of a `QueryPanel`: what the where editor
// suggests per source, from the lookups and metric keys the host has read.

/** A host's lookup slots, by lookup name. */
export type AutocompleteSlots = Readonly<Record<string, Keyed<LookupNames, LoadFailure>>>

/** One field of a lookup's answer once read, or none. */
export const autocompleteField = (
	slots: AutocompleteSlots,
	lookup: AutocompleteLookup,
	name: string,
): Array<string> => [
	...lookupField(Option.getOrUndefined(AsyncData.getData(slots[lookup]?.data ?? AsyncData.Idle())), name),
]

/** The trace facets a traces query suggests. */
export type TraceFacetNames = Readonly<{
	services: ReadonlyArray<string>
	spanNames: ReadonlyArray<string>
	environments: ReadonlyArray<string>
	httpMethods: ReadonlyArray<string>
	httpStatusCodes: ReadonlyArray<string>
}>

/** The facets the `tracesFacets` lookup answered. */
export const lookupTraceFacets = (slots: AutocompleteSlots): TraceFacetNames => ({
	services: autocompleteField(slots, "tracesFacets", "services"),
	spanNames: autocompleteField(slots, "tracesFacets", "spanNames"),
	environments: autocompleteField(slots, "tracesFacets", "environments"),
	httpMethods: autocompleteField(slots, "tracesFacets", "httpMethods"),
	httpStatusCodes: autocompleteField(slots, "tracesFacets", "httpStatusCodes"),
})

/** The picked metric's own keys, once read; none for another source or before a metric is picked. */
export const metricKeysOf = (
	metricKeys: Readonly<Record<string, MetricKeys>>,
	query: QueryDraft,
): MetricKeys | undefined =>
	query.dataSource === "metrics" && query.metricName !== "" ? metricKeys[metricValueOf(query)] : undefined

/** What a host read for the where editor; each source is read only for the query that needs it. */
export type WhereValueSources = Readonly<{
	slots: AutocompleteSlots
	traceFacets: () => TraceFacetNames
	/** The attribute keys a metrics query suggests. */
	metricAttributeKeys: () => ReadonlyArray<string>
	metricServices: ReadonlyArray<string>
}>

/** The where editor's suggestions for one source. */
export const whereValuesOf = (
	dataSource: QueryDraft["dataSource"],
	sources: WhereValueSources,
): WhereClauseAutocompleteValues => {
	const field = (lookup: AutocompleteLookup, name: string) => autocompleteField(sources.slots, lookup, name)
	switch (dataSource) {
		case "traces": {
			const facets = sources.traceFacets()
			return {
				services: [...facets.services],
				spanNames: [...facets.spanNames],
				environments: [...facets.environments],
				httpMethods: [...facets.httpMethods],
				httpStatusCodes: [...facets.httpStatusCodes],
				attributeKeys: field("spanAttributeKeys", "keys"),
				resourceAttributeKeys: field("resourceAttributeKeys", "keys"),
			}
		}
		case "logs":
			return {
				services: field("logsFacets", "services"),
				severities: field("logsFacets", "severities"),
				attributeKeys: field("spanAttributeKeys", "keys"),
				resourceAttributeKeys: field("resourceAttributeKeys", "keys"),
			}
		case "metrics":
			return {
				metricTypes: [...QUERY_BUILDER_METRIC_TYPES],
				attributeKeys: [...sources.metricAttributeKeys()],
				services: [...sources.metricServices],
			}
		case "product_events":
			return {
				eventNames: field("productEventNames", "keys"),
				attributeKeys: field("productEventAttributeKeys", "keys"),
			}
	}
}
