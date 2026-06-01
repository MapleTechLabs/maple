import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { getSessionTraces } from "./session-replays"
import { ObservabilityError, WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorShape } from "./WarehouseExecutor"

interface Captured {
	sqls: string[]
}

/**
 * Mock executor whose `sqlQuery` records each SQL string. The wrapper always
 * runs the session-detail query first, so the Nth call's rows come from the
 * Nth element of `responses` (detail row(s), then trace-summary row(s)).
 */
const makeExecutor = (
	captured: Captured,
	responses: ReadonlyArray<ReadonlyArray<Record<string, unknown>>>,
): WarehouseExecutorShape => ({
	orgId: "org_test",
	query: () => Effect.succeed({ data: [] as ReadonlyArray<never> }),
	sqlQuery: ((sql: string) => {
		const rows = responses[captured.sqls.length] ?? []
		captured.sqls.push(sql)
		return Effect.succeed(rows as ReadonlyArray<never>)
	}) as WarehouseExecutorShape["sqlQuery"],
})

const makeLayer = (executor: WarehouseExecutorShape) => Layer.succeed(WarehouseExecutor, executor)

const traceIds = (n: number) => Array.from({ length: n }, (_, i) => `trace-${i}`)

describe("getSessionTraces", () => {
	it.effect("returns null session and runs only the detail query when none found", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "missing" }).pipe(
				Effect.provide(makeLayer(makeExecutor(captured, [[]]))),
			)

			assert.isNull(out.session)
			assert.deepStrictEqual(out.traces, [])
			assert.strictEqual(out.totalTraceCount, 0)
			assert.strictEqual(captured.sqls.length, 1)
		}),
	)

	it.effect("skips the summaries query when the session has no correlated traces", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(makeLayer(makeExecutor(captured, [[{ sessionId: "s1", traceIds: [] }]]))),
			)

			assert.isNotNull(out.session)
			assert.deepStrictEqual(out.traces, [])
			assert.strictEqual(out.totalTraceCount, 0)
			// Only the detail query ran — `TraceId IN ()` is never compiled.
			assert.strictEqual(captured.sqls.length, 1)
		}),
	)

	it.effect("clamps the IN-list to the default of 50 trace ids", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			const out = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(
					makeLayer(makeExecutor(captured, [[{ sessionId: "s1", traceIds: traceIds(150) }], []])),
				),
			)

			assert.strictEqual(out.totalTraceCount, 150)
			assert.strictEqual(captured.sqls.length, 2)
			const summarySql = captured.sqls[1]!
			assert.include(summarySql, "trace-49")
			assert.notInclude(summarySql, "trace-50")
		}),
	)

	it.effect("caps an oversized explicit limit at 100", () =>
		Effect.gen(function* () {
			const captured: Captured = { sqls: [] }
			yield* getSessionTraces({ sessionId: "s1", limit: 999 }).pipe(
				Effect.provide(
					makeLayer(makeExecutor(captured, [[{ sessionId: "s1", traceIds: traceIds(150) }], []])),
				),
			)

			const summarySql = captured.sqls[1]!
			assert.include(summarySql, "trace-99")
			assert.notInclude(summarySql, "trace-100")
		}),
	)

	it.effect("propagates ObservabilityError from the executor", () =>
		Effect.gen(function* () {
			const failing: WarehouseExecutorShape = {
				orgId: "org_test",
				query: () => Effect.succeed({ data: [] }),
				sqlQuery: () =>
					Effect.fail(new ObservabilityError({ message: "ClickHouse exploded", category: "upstream" })),
			}

			const error = yield* getSessionTraces({ sessionId: "s1" }).pipe(
				Effect.provide(makeLayer(failing)),
				Effect.flip,
			)

			assert.instanceOf(error, ObservabilityError)
			assert.strictEqual(error.message, "ClickHouse exploded")
		}),
	)
})
