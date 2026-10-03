import { Array as Arr, Effect, Order, pipe } from "effect"
import type {
	SpanAttributeKeysOutput,
	SpanAttributeValuesOutput,
	ResourceAttributeValuesOutput,
} from "@maple/domain/tinybird"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { ExploreAttributesInput, AttributeKeyResult, AttributeValueResult } from "./types"

// All three key endpoints (span_attribute_keys, resource_attribute_keys, metric_attribute_keys)
// share the same output shape: { attributeKey, usageCount }
type AttributeKeyRow = SpanAttributeKeysOutput

// Both value endpoints share: { attributeValue, usageCount }
type AttributeValueRow = SpanAttributeValuesOutput | ResourceAttributeValuesOutput

const byCountDesc = Order.mapInput(Order.flip(Order.Number), (r: AttributeKeyResult) => r.count)

/**
 * Pipe params that scope metrics discovery to one metric, so keys come from that
 * metric's own data points (any metric type) instead of the org-wide sum rollup.
 * A missing metric type is looked up in the metric catalog (scoped to the
 * service); `undefined` means the named metric was not found, so callers
 * return nothing rather than the unscoped rollup.
 */
const metricScopeParams = Effect.fnUntraced(function* (input: ExploreAttributesInput) {
	if (input.source !== "metrics" || input.metricName === undefined) return {}
	let metricType = input.metricType
	if (metricType === undefined) {
		const executor = yield* WarehouseExecutor
		const catalog = yield* executor.query<{ metricName: string; metricType: string }>(
			"list_metrics",
			{
				start_time: input.timeRange.startTime,
				end_time: input.timeRange.endTime,
				search: input.metricName,
				...(input.service && { service: input.service }),
				limit: 500,
			},
			{ profile: "discovery" },
		)
		metricType = catalog.data.find((row) => row.metricName === input.metricName)?.metricType
	}
	return metricType === undefined ? undefined : { metric_name: input.metricName, metric_type: metricType }
})

export const exploreAttributeKeys = Effect.fn("Observability.exploreAttributeKeys")(function* (
	input: ExploreAttributesInput,
) {
	const executor = yield* WarehouseExecutor

	const pipeName =
		input.source === "traces"
			? input.scope === "resource"
				? ("resource_attribute_keys" as const)
				: ("span_attribute_keys" as const)
			: input.source === "metrics"
				? ("metric_attribute_keys" as const)
				: ("services_facets" as const)

	yield* Effect.annotateCurrentSpan({
		source: input.source,
		scope: input.scope ?? "span",
		service: input.service ?? "all",
		pipe: pipeName,
	})

	if (pipeName === "services_facets") {
		// One row per (facetType, name) across environments, namespaces, commit
		// SHAs and services, each capped by the pipe rather than by `limit`. The
		// facet type prefixes the key (as the MCP tool spells it) so a bare
		// "development" cannot pass for a service.
		const result = yield* executor.query<{ name: string; count: number; facetType: string }>(
			pipeName,
			{
				start_time: input.timeRange.startTime,
				end_time: input.timeRange.endTime,
			},
			{ profile: "discovery" },
		)
		return pipe(
			result.data,
			Arr.map((d): AttributeKeyResult => ({
				key: `${d.facetType}:${d.name}`,
				count: Number(d.count),
				facetType: d.facetType,
			})),
			Arr.sort(byCountDesc),
			Arr.take(input.limit ?? 50),
		)
	}

	const metricScope = yield* metricScopeParams(input)
	if (metricScope === undefined) return []
	const result = yield* executor.query<AttributeKeyRow>(
		pipeName,
		{
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { service_name: input.service }),
			...metricScope,
			limit: input.limit ?? 50,
		},
		{ profile: "discovery" },
	)

	return pipe(
		result.data,
		Arr.map((d): AttributeKeyResult => ({ key: d.attributeKey, count: Number(d.usageCount) })),
	)
})

export const exploreAttributeValues = Effect.fn("Observability.exploreAttributeValues")(function* (
	input: ExploreAttributesInput & { key: string },
) {
	const executor = yield* WarehouseExecutor

	const pipeName =
		input.source === "metrics"
			? ("metric_attribute_values" as const)
			: input.scope === "resource"
				? ("resource_attribute_values" as const)
				: ("span_attribute_values" as const)

	yield* Effect.annotateCurrentSpan({
		source: input.source,
		scope: input.scope ?? "span",
		key: input.key,
		service: input.service ?? "all",
		pipe: pipeName,
	})

	const metricScope = yield* metricScopeParams(input)
	if (metricScope === undefined) return []
	const result = yield* executor.query<AttributeValueRow>(
		pipeName,
		{
			attribute_key: input.key,
			start_time: input.timeRange.startTime,
			end_time: input.timeRange.endTime,
			...(input.service && { service_name: input.service }),
			...metricScope,
			limit: input.limit ?? 50,
		},
		{ profile: "discovery" },
	)

	yield* Effect.annotateCurrentSpan("result.rowCount", result.data.length)

	return pipe(
		result.data,
		Arr.map((d): AttributeValueResult => ({ value: d.attributeValue, count: Number(d.usageCount) })),
	)
})
