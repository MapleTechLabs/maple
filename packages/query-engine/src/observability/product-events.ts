import { Effect } from "effect"
import * as CH from "../ch"
import { WarehouseExecutor } from "./WarehouseExecutor"

export type {
	ProductEventNamesOutput,
	ProductEventsFunnelBreakdownOutput,
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
