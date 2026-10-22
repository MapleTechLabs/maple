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

// The autocomplete lookups a
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

/** A lookup's answer: the names it suggests, by field (`services`, `severities`, `keys`...). */
export const LookupNames = Schema.Record(Schema.String, Schema.Array(Schema.String))
export type LookupNames = typeof LookupNames.Type

/** `toNames`: trimmed, non-empty, each once. */
const names = (rows: ReadonlyArray<{ readonly name: string }> | undefined): ReadonlyArray<string> =>
	(rows ?? [])
		.map((row) => row.name.trim())
		.filter((name, index, all) => name !== "" && all.indexOf(name) === index)
const keysOf = (response: {
	readonly data: ReadonlyArray<{ readonly attributeKey: string }>
}): LookupNames => ({
	keys: response.data.map((row) => row.attributeKey),
})

/** One field of a lookup's answer, or none. */
export const lookupField = (answer: LookupNames | undefined, field: string): ReadonlyArray<string> =>
	answer?.[field] ?? []

/** One provider lookup over a window. */
export const autocompleteLookup = (
	name: AutocompleteLookup,
	window: TimeWindow,
): Effect.Effect<LookupNames, unknown, WarehouseExecutor | MapleInternalHttp> => {
	switch (name) {
		case "tracesFacets":
			return Effect.map(getTracesFacets({ data: window }), ({ data }) => ({
				services: names(data.services),
				spanNames: names(data.spanNames),
				environments: names(data.deploymentEnvs),
				httpMethods: names(data.httpMethods),
				httpStatusCodes: names(data.httpStatusCodes),
			}))
		case "logsFacets":
			return Effect.map(getLogsFacets({ data: window }), ({ data }) => ({
				services: names(data.services),
				severities: names(data.severities),
			}))
		case "spanAttributeKeys":
			return Effect.map(getSpanAttributeKeys({ data: window }), keysOf)
		case "resourceAttributeKeys":
			return Effect.map(getResourceAttributeKeys({ data: window }), keysOf)
		case "metricAttributeKeys":
			return Effect.map(getMetricAttributeKeys({ data: window }), keysOf)
		case "productEventNames":
			return Effect.map(getProductEventNames({ data: { ...window, limit: 200 } }), (response) => ({
				keys: response.data.map((row) => row.eventName),
			}))
		case "productEventAttributeKeys":
			return Effect.map(getProductEventAttributeKeys({ data: window }), keysOf)
	}
}
