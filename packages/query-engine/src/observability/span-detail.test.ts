import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer, Array as Arr, String as Str } from "effect"
import { spanDetail } from "./span-detail"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"
import { OrgId } from "@maple/domain"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

const detailRow = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	parentSpanId: "",
	spanName: "GET /orders",
	rawSpanName: "GET",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-03-20 08:00:00.123456789",
	statusCode: "Unset",
	statusMessage: "",
	spanAttributes: JSON.stringify({ "http.route": "/orders" }),
	resourceAttributes: "{}",
}

const probeRow = {
	traceId: TRACE_ID,
	timestamp: "2026-03-20 07:59:58.000000000",
	endTimestamp: "2026-03-20 08:00:03.000000000",
}

const isProbe = (sql: string) => Str.includes("FROM trace_index")(sql) && !Str.includes("FROM traces")(sql)

/**
 * A warehouse holding the span. A hinted (bounded) lookup misses unless `boundedHit`, as if the
 * hint pointed elsewhere; the trace-bounds probe answers when `indexed`.
 */
const makeExecutor = (
	sqls: string[],
	opts: { readonly indexed?: boolean; readonly boundedHit?: boolean } = {},
): WarehouseExecutorApi => ({
	orgId: OrgId.make("org_test"),
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => {
		const query = compiledQueryOf(compiled)
		sqls.push(query.sql)
		if (isProbe(query.sql))
			return query.decodeFirstRow(opts.indexed === false ? [] : [probeRow]).pipe(Effect.orDie)
		const bounded = Str.includes("Timestamp >=")(query.sql)
		return query
			.decodeFirstRow(!bounded || opts.boundedHit === true ? [detailRow] : [])
			.pipe(Effect.orDie)
	},
	query: () => Effect.succeed({ data: [] }),
})

const run = (
	sqls: string[],
	timestampHint?: Date,
	opts?: { readonly indexed?: boolean; readonly boundedHit?: boolean },
) =>
	spanDetail({ traceId: TRACE_ID, spanId: SPAN_ID, timestampHint }).pipe(
		Effect.provide(Layer.succeed(WarehouseExecutor, makeExecutor(sqls, opts))),
	)

/** A timestamp hint far from where the fixture trace actually is. */
const STALE_HINT = new Date("2026-04-05T12:00:00Z")

describe("spanDetail", () => {
	it.effect("retries unbounded once when the hinted window misses", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, STALE_HINT)
			assert.isTrue(result.found)
			assert.isTrue(result.widened)
			assert.lengthOf(sqls, 2)
			assert.isFalse(Arr.some(sqls, isProbe))
			assert.deepStrictEqual(result.spanAttributes, { "http.route": "/orders" })
		}),
	)

	it.effect("without a hint, reads the span inside the trace's indexed bounds", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { boundedHit: true })
			assert.isTrue(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 2)
			assert.isTrue(isProbe(sqls[0]))
			assert.include(sqls[1], "Timestamp >=")
		}),
	)

	it.effect("reports an unindexed trace as not found without scanning retention", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { indexed: false })
			assert.isFalse(result.found)
			assert.lengthOf(sqls, 1)
		}),
	)

	it.effect("does not widen a miss inside the trace's own bounds", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, undefined, { boundedHit: false })
			assert.isFalse(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 2)
		}),
	)

	it.effect("returns the stored name, status and timing beside the attributes", () =>
		Effect.gen(function* () {
			const result = yield* run([], undefined, { boundedHit: true })
			assert.deepStrictEqual(result.span, {
				spanName: "GET /orders",
				rawSpanName: "GET",
				serviceName: "api",
				spanKind: "Server",
				durationMs: 12,
				startTime: "2026-03-20 08:00:00.123",
				statusCode: "Unset",
				statusMessage: "",
			})
		}),
	)
})
