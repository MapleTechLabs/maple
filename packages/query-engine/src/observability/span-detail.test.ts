import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { spanDetail } from "./span-detail"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"

const detailRow = {
	traceId: TRACE_ID,
	spanId: SPAN_ID,
	parentSpanId: "",
	spanName: "GET /orders",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-03-20 08:00:00.000000000",
	statusCode: "Unset",
	statusMessage: "",
	spanAttributes: JSON.stringify({ "http.route": "/orders" }),
	resourceAttributes: "{}",
}

/** Answers only unbounded lookups, as if the hinted window missed the span. */
const makeExecutor = (sqls: string[]): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => {
		const query = compiledQueryOf(compiled)
		sqls.push(query.sql)
		const bounded = query.sql.includes("Timestamp >=")
		return query.decodeFirstRow(bounded ? [] : [detailRow]).pipe(Effect.orDie)
	},
	query: () => Effect.succeed({ data: [] }),
})

const run = (sqls: string[], timestampHint?: Date) =>
	spanDetail({ traceId: TRACE_ID, spanId: SPAN_ID, timestampHint }).pipe(
		Effect.provide(Layer.succeed(WarehouseExecutor, makeExecutor(sqls))),
	)

describe("spanDetail", () => {
	it.effect("retries unbounded once when the hinted window misses", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, new Date("2026-04-05T12:00:00Z"))
			assert.isTrue(result.found)
			assert.isTrue(result.widened)
			assert.lengthOf(sqls, 2)
			assert.deepStrictEqual(result.spanAttributes, { "http.route": "/orders" })
		}),
	)

	it.effect("does one lookup without a hint", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls)
			assert.isTrue(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 1)
		}),
	)
})
