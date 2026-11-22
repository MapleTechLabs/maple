import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type { ProductEventsRetentionOutput } from "../ch/queries/product-events-retention"
export type {
	ProductEventNamesOutput,
	ProductEventsFunnelBreakdownOutput,
	ProductEventsFunnelCoverageOutput,
	ProductEventsFunnelOutput,
} from "../ch/queries/product-events"

// Product-event funnels for the MCP tools. Thin wrappers over the CH builders in
// `../ch/queries/product-events.ts`; a definition the builder rejects surfaces as
// a typed `ProductEventsFunnelError` so a tool can print the reason instead of dying.

export interface ProductEventsFunnelInput extends CH.ProductEventsFunnelOpts {
	readonly startTime: string
	readonly endTime: string
}

export interface ProductEventsFunnelBreakdownInput extends CH.ProductEventsFunnelBreakdownOpts {
	readonly startTime: string
	readonly endTime: string
}

export interface ProductEventNamesInput extends CH.ProductEventNamesOpts {
	readonly startTime: string
	readonly endTime: string
}

/** Run a funnel: exactly one `{ step, count }` row per step, in step order. */
export const productEventsFunnel = Effect.fn("Observability.productEventsFunnel")(function* (
	input: ProductEventsFunnelInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		"maple.funnel.steps": input.steps.length,
		"maple.funnel.key_by": input.keyBy,
	})
	const { startTime, endTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsFunnelQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
	return yield* executor.compiledQuery(compiled, { profile: "aggregation", context: "productEventsFunnel" })
})

/** Run a funnel broken down by a session dimension or an event attribute: `{ group, step, count }` rows. */
export const productEventsFunnelBreakdown = Effect.fn("Observability.productEventsFunnelBreakdown")(
	function* (input: ProductEventsFunnelBreakdownInput) {
		const executor = yield* WarehouseExecutor
		yield* Effect.annotateCurrentSpan({
			orgId: executor.orgId,
			"maple.funnel.steps": input.steps.length,
			"maple.funnel.key_by": input.keyBy,
			"maple.funnel.breakdown_by": input.breakdownBy,
		})
		const { startTime, endTime, ...opts } = input
		const query = yield* Effect.fromResult(CH.productEventsFunnelBreakdownQuery(opts))
		const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
		return yield* executor.compiledQuery(compiled, {
			profile: "aggregation",
			context: "productEventsFunnelBreakdown",
		})
	},
)

/** Per step, the matching events in range and how many carry each identity a funnel can count by. */
export const productEventsFunnelCoverage = Effect.fn("Observability.productEventsFunnelCoverage")(function* (
	input: ProductEventsFunnelInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		"maple.funnel.steps": input.steps.length,
		"maple.funnel.key_by": input.keyBy,
	})
	const { startTime, endTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsFunnelCoverageQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
	return yield* executor.compiledQuery(compiled, {
		profile: "aggregation",
		context: "productEventsFunnelCoverage",
	})
})

/** Time between a funnel's steps, for steps 2..N: medians and p90s since the previous step and since step 1. */
export const productEventsFunnelTiming = Effect.fn("Observability.productEventsFunnelTiming")(function* (
	input: ProductEventsFunnelInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({ orgId: executor.orgId, "maple.funnel.steps": input.steps.length })
	const { startTime, endTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsFunnelTimingQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
	return yield* executor.compiledQuery(compiled, {
		profile: "aggregation",
		context: "productEventsFunnelTiming",
	})
})

/** What the people who stopped before each step did next: `{ step, next, count }`, most common first. */
export const productEventsFunnelLeavers = Effect.fn("Observability.productEventsFunnelLeavers")(function* (
	input: ProductEventsFunnelInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({ orgId: executor.orgId, "maple.funnel.steps": input.steps.length })
	const { startTime, endTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsFunnelLeaversQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
	return yield* executor.compiledQuery(compiled, {
		profile: "aggregation",
		context: "productEventsFunnelLeavers",
	})
})

export interface ProductEventsPathsInput extends CH.ProductEventsPathsOpts {
	readonly startTime: string
	readonly endTime: string
}

/** What people did in the hops after (or before) one anchor: `{ hop, fromNode, toNode, count }`. */
export const productEventsPaths = Effect.fn("Observability.productEventsPaths")(function* (
	input: ProductEventsPathsInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		"maple.paths.direction": input.direction,
		"maple.paths.depth": input.depth,
		"maple.paths.key_by": input.keyBy,
	})
	const { startTime, endTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsPathsQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime })
	return yield* executor.compiledQuery(compiled, { profile: "aggregation", context: "productEventsPaths" })
})

export interface ProductEventsRetentionInput extends CH.ProductEventsRetentionOpts {
	/** The cohort window: a key is in a cohort when its first start event falls inside it. */
	readonly startTime: string
	readonly endTime: string
	/** Returns are read up to here, so the last cohorts can be followed past `endTime`. */
	readonly returnEndTime: string
}

/** Retention cohorts: `{ cohort, period, count }`, period 0 being the cohort's size. */
export const productEventsRetention = Effect.fn("Observability.productEventsRetention")(function* (
	input: ProductEventsRetentionInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan({
		orgId: executor.orgId,
		"maple.retention.key_by": input.keyBy,
		"maple.retention.interval": input.interval,
		"maple.retention.periods": input.periods,
		"maple.retention.first_ever": input.firstEver,
	})
	const { startTime, endTime, returnEndTime, ...opts } = input
	const query = yield* Effect.fromResult(CH.productEventsRetentionQuery(opts))
	const compiled = CH.compile(query, { orgId: executor.orgId, startTime, endTime, returnEndTime })
	return yield* executor.compiledQuery(compiled, {
		profile: "aggregation",
		context: "productEventsRetention",
	})
})

export interface ProductEventAttributesInput {
	readonly startTime: string
	readonly endTime: string
	/** Only props seen on this event. */
	readonly eventName?: string
	readonly limit: number
}

const attributeScope = (input: ProductEventAttributesInput) =>
	input.eventName === undefined ? {} : { eventNames: [input.eventName] }

/** The `track()` prop keys in range, most used first: `{ attributeKey, usageCount }`. */
export const productEventAttributeKeys = Effect.fn("Observability.productEventAttributeKeys")(function* (
	input: ProductEventAttributesInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.productEventAttributeKeysQuery({ ...attributeScope(input), limit: input.limit }),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, {
		profile: "discovery",
		context: "productEventAttributeKeys",
	})
})

/** One prop's values in range, most used first: `{ attributeValue, usageCount }`. */
export const productEventAttributeValues = Effect.fn("Observability.productEventAttributeValues")(function* (
	input: ProductEventAttributesInput & { readonly key: string },
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const compiled = CH.compile(
		CH.productEventAttributeValuesQuery({
			...attributeScope(input),
			attributeKey: input.key,
			limit: input.limit,
		}),
		{ orgId: executor.orgId, startTime: input.startTime, endTime: input.endTime },
	)
	return yield* executor.compiledQuery(compiled, {
		profile: "discovery",
		context: "productEventAttributeValues",
	})
})

/** The event names in range, most frequent first: `{ eventName, kind, count, sessions, persons }`. */
export const productEventNames = Effect.fn("Observability.productEventNames")(function* (
	input: ProductEventNamesInput,
) {
	const executor = yield* WarehouseExecutor
	yield* Effect.annotateCurrentSpan("orgId", executor.orgId)
	const { startTime, endTime, ...opts } = input
	const compiled = CH.compile(CH.productEventNamesQuery(opts), {
		orgId: executor.orgId,
		startTime,
		endTime,
	})
	return yield* executor.compiledQuery(compiled, { profile: "aggregation", context: "productEventNames" })
})
