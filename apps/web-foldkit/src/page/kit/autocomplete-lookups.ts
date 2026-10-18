import { getLogsFacets } from "@maple/web-data/warehouse/logs"
import { getMetricAttributeKeys } from "@maple/web-data/warehouse/metrics"
import { getProductEventAttributeKeys, getProductEventNames } from "@maple/web-data/warehouse/product-events"
import {
	getResourceAttributeKeys,
	getSpanAttributeKeys,
	getTracesFacets,
} from "@maple/web-data/warehouse/traces"
import type { MapleInternalHttp, WarehouseExecutor } from "@maple/web-data/warehouse/warehouse-services"
import { Effect, Schema } from "effect"
import type { TimeWindow } from "../../data/time-range"

// `AutocompleteValuesProvider` (apps/web/src/hooks/use-autocomplete-values.tsx): the lookups a
// query builder fetches once it is first focused, each reduced to the names it suggests.

export const AutocompleteLookup = Schema.Literals([
	"tracesFacets",
	"logsFacets",
	"spanAttributeKeys",
	"resourceAttributeKeys",
	"metricAttributeKeys",
	"productEventNames",
	"productEventAttributeKeys",
])
export type AutocompleteLookup = typeof AutocompleteLookup.Type

export const AUTOCOMPLETE_LOOKUPS: ReadonlyArray<AutocompleteLookup> = AutocompleteLookup.literals

const names = (rows: ReadonlyArray<{ readonly name: string }>) => rows.map((row) => row.name)
const keysOf = (response: { readonly data: ReadonlyArray<{ readonly attributeKey: string }> }) =>
	response.data.map((row) => row.attributeKey)

/** One provider lookup over a window. */
export const autocompleteLookup = (
	name: AutocompleteLookup,
	window: TimeWindow,
): Effect.Effect<ReadonlyArray<string>, unknown, WarehouseExecutor | MapleInternalHttp> => {
	switch (name) {
		case "tracesFacets":
			return Effect.map(getTracesFacets({ data: window }), (response) => names(response.data.services))
		case "logsFacets":
			return Effect.map(getLogsFacets({ data: window }), (response) => names(response.data.services))
		case "spanAttributeKeys":
			return Effect.map(getSpanAttributeKeys({ data: window }), keysOf)
		case "resourceAttributeKeys":
			return Effect.map(getResourceAttributeKeys({ data: window }), keysOf)
		case "metricAttributeKeys":
			return Effect.map(getMetricAttributeKeys({ data: window }), keysOf)
		case "productEventNames":
			return Effect.map(getProductEventNames({ data: { ...window, limit: 200 } }), (response) =>
				response.data.map((row) => row.eventName),
			)
		case "productEventAttributeKeys":
			return Effect.map(getProductEventAttributeKeys({ data: window }), keysOf)
	}
}
