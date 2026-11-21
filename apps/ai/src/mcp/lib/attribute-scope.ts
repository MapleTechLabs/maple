import { Effect, Schema, Array as Arr } from "effect"
import { QueryEngineExecuteRequest } from "@maple/domain/query-engine"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { CurrentMcpTenant } from "../tenant"
import { withTenantExecutor } from "./query-warehouse"
import { orFallback } from "./fallback"

export type AttributeScope = "span" | "resource"

export interface AttributeScopeRequest {
	readonly source: "traces" | "logs" | "metrics" | "product_events"
	readonly attribute_key?: string | undefined
	readonly attribute_scope?: AttributeScope | undefined
	readonly group_by?: string | undefined
	readonly metric_name?: string | undefined
	readonly metric_type?: string | undefined
}

export interface ResolvedAttributeScope {
	readonly scope: AttributeScope
	/** Set when the scope was inferred as `resource`, for the result's decisions list. */
	readonly decision?: string
}

/**
 * Where a key lives, from the keys seen in the window: the primary map (span,
 * log or metric label) wins when it has the key; otherwise a known resource key
 * goes to the resource map. Unknown keys stay on the primary map.
 */
export const pickAttributeScope = (
	key: string,
	primaryKeys: ReadonlyArray<string>,
	resourceKeys: ReadonlyArray<string> | "unknown",
): AttributeScope => {
	if (primaryKeys.includes(key)) return "span"
	if (resourceKeys === "unknown") return primaryKeys.length > 0 ? "resource" : "span"
	return resourceKeys.includes(key) ? "resource" : "span"
}

const traceKeys = (scope: AttributeScope, window: { startTime: string; endTime: string }) =>
	withTenantExecutor(
		exploreAttributeKeys({ source: "traces", scope, timeRange: window, limit: 1000 }),
	).pipe(
		Effect.map((rows) => Arr.map(rows, (r) => r.key)),
		orFallback("trace attribute keys", (): ReadonlyArray<string> => []),
	)

/** The keys seen in the window: on the primary map, and on the resource map where it is catalogued. */
export interface KnownAttributeKeys {
	readonly primary: ReadonlyArray<string>
	readonly resource: ReadonlyArray<string> | "unknown"
}

const decodeKeysRequest = Schema.decodeUnknownEffect(QueryEngineExecuteRequest)

/** The most keys one catalogue read returns: a shorter answer is the whole catalogue. */
const CATALOGUE_LIMIT = 500

/** The keys the query engine catalogues for one map of a source, most used first. */
const cataloguedKeys = (
	lookup: string,
	window: { readonly startTime: string; readonly endTime: string },
	query: Readonly<Record<string, unknown>>,
) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentMcpTenant
		const engine = yield* QueryEngineService
		const request = yield* decodeKeysRequest({
			...window,
			query: { kind: "attributeKeys", limit: CATALOGUE_LIMIT, ...query },
		})
		const { result } = yield* engine.execute(tenant, request)
		return result.kind === "attributeKeys" ? Arr.map(result.data, (item) => item.key) : []
	}).pipe(orFallback(lookup, (): ReadonlyArray<string> => []))

/**
 * A log's two maps, given its record keys. Log resource keys are not catalogued: a key missing
 * from a complete record catalogue is on the resource, and past the cap the trace resource keys say.
 */
export const logAttributeKeys = <R>(
	recordKeys: ReadonlyArray<string>,
	traceResourceKeys: Effect.Effect<ReadonlyArray<string>, never, R>,
): Effect.Effect<KnownAttributeKeys, never, R> =>
	recordKeys.length < CATALOGUE_LIMIT
		? Effect.succeed({ primary: recordKeys, resource: "unknown" })
		: Effect.map(traceResourceKeys, (resource) => ({ primary: recordKeys, resource }))

/** Reads the keys a scope is picked from, off the maps of the source the query reads. */
export const knownAttributeKeys = Effect.fn("McpTool.knownAttributeKeys")(function* (
	params: Pick<AttributeScopeRequest, "source" | "metric_name" | "metric_type">,
	window: { readonly startTime: string; readonly endTime: string },
) {
	if (params.source === "metrics") {
		// Both of the metric's own maps: a metric without labels still has resource attributes.
		const metric = { source: "metrics", metricName: params.metric_name, metricType: params.metric_type }
		const primary = yield* cataloguedKeys("metric attribute keys", window, metric)
		const resource = yield* cataloguedKeys("metric resource keys", window, {
			...metric,
			scope: "resource",
		})
		return { primary, resource } satisfies KnownAttributeKeys
	}
	if (params.source === "logs") {
		const recordKeys = yield* cataloguedKeys("log attribute keys", window, { source: "logs" })
		return yield* logAttributeKeys(recordKeys, traceKeys("resource", window))
	}
	const primary = yield* traceKeys("span", window)
	const resource = yield* traceKeys("resource", window)
	return { primary, resource } satisfies KnownAttributeKeys
})

export const resolveAttributeScope = Effect.fn("McpTool.resolveAttributeScope")(function* (
	params: AttributeScopeRequest,
	window: { readonly startTime: string; readonly endTime: string },
	/** The window's keys, when the caller already reads them for other keys. */
	known?: ReturnType<typeof knownAttributeKeys>,
) {
	const fixed = (scope: AttributeScope): ResolvedAttributeScope => ({ scope })
	const key = params.attribute_key
	if (key === undefined) return fixed("span")
	if (params.attribute_scope !== undefined) return fixed(params.attribute_scope)
	if (params.group_by === "resource_attribute") return fixed("resource")
	if (params.source === "product_events") return fixed("span")

	const keys = yield* known ?? knownAttributeKeys(params, window)
	const scope = pickAttributeScope(key, keys.primary, keys.resource)
	return scope === "resource"
		? ({
				scope,
				decision: `attribute_key: "${key}" is a resource attribute here, so it was matched on resource attributes (attribute_scope overrides)`,
			} satisfies ResolvedAttributeScope)
		: fixed(scope)
})
