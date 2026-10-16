import { Effect } from "effect"
import { exploreAttributeKeys } from "@maple/query-engine/observability"
import { queryWarehouse, withTenantExecutor } from "./query-warehouse"

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
	withTenantExecutor(exploreAttributeKeys({ source: "traces", scope, timeRange: window, limit: 1000 })).pipe(
		Effect.map((rows) => rows.map((r) => r.key)),
		Effect.orElseSucceed((): ReadonlyArray<string> => []),
	)

export const resolveAttributeScope = Effect.fn("McpTool.resolveAttributeScope")(function* (
	params: AttributeScopeRequest,
	window: { readonly startTime: string; readonly endTime: string },
) {
	const fixed = (scope: AttributeScope): ResolvedAttributeScope => ({ scope })
	const key = params.attribute_key
	if (key === undefined) return fixed("span")
	if (params.attribute_scope !== undefined) return fixed(params.attribute_scope)
	if (params.group_by === "resource_attribute") return fixed("resource")
	if (params.source === "product_events") return fixed("span")

	const scope =
		params.source === "metrics"
			? pickAttributeScope(
					key,
					// A metric's own label set; resource keys of metrics are not catalogued.
					yield* queryWarehouse<KeyRow>("metric_attribute_keys", {
						metric_name: params.metric_name,
						metric_type: params.metric_type,
						start_time: window.startTime,
						end_time: window.endTime,
						limit: 1000,
					}).pipe(
						Effect.map(({ data }) => data.map((r) => r.attributeKey)),
						Effect.orElseSucceed((): ReadonlyArray<string> => []),
					),
					"unknown",
				)
			: pickAttributeScope(
					key,
					yield* traceKeys("span", window),
					yield* traceKeys("resource", window),
				)
	return scope === "resource"
		? ({
				scope,
				decision: `attribute_key: "${key}" is a resource attribute here, so it was matched on resource attributes (attribute_scope overrides)`,
			} satisfies ResolvedAttributeScope)
		: fixed(scope)
})
