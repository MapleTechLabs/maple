import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { TestClock } from "effect/testing"
import { spanDetail } from "./span-detail"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"
import { OrgId } from "@maple/domain"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"
const SPAN_ID = "b7ad6b7169203331"
const NOW = Date.parse("2026-04-10T00:00:00Z")

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

/** Answers the unbounded read, and the bounded ones whose bounds hold the span's start time. */
const makeExecutor = (sqls: string[]): WarehouseExecutorApi => ({
	orgId: OrgId.make("org_test"),
	compiledQuery: (compiled) => {
		const query = compiledQueryOf(compiled)
		sqls.push(query.sql)
		const [, start] = /Timestamp >= '([^']+)'/.exec(query.sql) ?? []
		const [, end] = /Timestamp <= '([^']+)'/.exec(query.sql) ?? []
		const inside =
			start === undefined ||
			end === undefined ||
			(start <= detailRow.startTime && detailRow.startTime <= end)
		return query.decodeRows(inside ? [detailRow] : []).pipe(Effect.orDie)
	},
	compiledQueryFirst: () => Effect.die("spanDetail reads rows"),
	query: () => Effect.succeed({ data: [] }),
})

const run = (sqls: string[], timestampHint?: Date) =>
	Effect.gen(function* () {
		yield* TestClock.setTime(NOW)
		return yield* spanDetail({ traceId: TRACE_ID, spanId: SPAN_ID, timestampHint }).pipe(
			Effect.provide(Layer.succeed(WarehouseExecutor, makeExecutor(sqls))),
		)
	})

describe("spanDetail", () => {
	it.effect("does one lookup when the hinted hour holds the span", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, new Date("2026-03-20T08:20:00Z"))
			assert.isTrue(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 1)
			assert.deepStrictEqual(result.spanAttributes, { "http.route": "/orders" })
		}),
	)

	it.effect("reads the recent days, then unbounded, when the hinted hour misses", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls, new Date("2026-04-05T12:00:00Z"))
			assert.isTrue(result.found)
			assert.isTrue(result.widened)
			assert.lengthOf(sqls, 3)
			assert.include(sqls[1], "Timestamp >= '2026-04-08 00:00:00'")
			assert.notInclude(sqls[2], "Timestamp >=")
		}),
	)

	it.effect("reads the recent days first without a hint", () =>
		Effect.gen(function* () {
			const sqls: string[] = []
			const result = yield* run(sqls)
			assert.isTrue(result.found)
			assert.isFalse(result.widened)
			assert.lengthOf(sqls, 2)
			assert.include(sqls[0], "Timestamp >= '2026-04-08 00:00:00'")
		}),
	)
})
