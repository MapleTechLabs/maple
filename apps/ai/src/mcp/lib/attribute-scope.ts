import { Effect, Array as Arr } from "effect"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { queryWarehouse, withTenantExecutor } from "./query-warehouse"
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

interface KeyRow {
	readonly attributeKey: string
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

/** Reads the keys a scope is picked from. Two warehouse reads, so a caller with several keys shares one. */
export const knownAttributeKeys = Effect.fn("McpTool.knownAttributeKeys")(function* (
	params: Pick<AttributeScopeRequest, "source" | "metric_name" | "metric_type">,
	window: { readonly startTime: string; readonly endTime: string },
) {
	if (params.source === "metrics") {
		// A metric's own label set; resource keys of metrics are not catalogued.
		const metricKeys = yield* queryWarehouse<KeyRow>("metric_attribute_keys", {
			metric_name: params.metric_name,
			metric_type: params.metric_type,
			start_time: window.startTime,
			end_time: window.endTime,
			limit: 1000,
		}).pipe(
			Effect.map(({ data }) => Arr.map(data, (r) => r.attributeKey)),
			orFallback("metric attribute keys", (): ReadonlyArray<string> => []),
		)
		return { primary: metricKeys, resource: "unknown" } satisfies KnownAttributeKeys
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
