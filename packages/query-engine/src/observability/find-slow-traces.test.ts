import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { findSlowTraces } from "./find-slow-traces"
import { ObservabilityError, TinybirdExecutor } from "./TinybirdExecutor"
import type { TinybirdExecutorShape } from "./TinybirdExecutor"

interface CapturedCalls {
	sqlQueries: string[]
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const makeMockExecutor = (
	captured: CapturedCalls,
	sqlRows: ReadonlyArray<Record<string, unknown>> = [],
	pipeData: ReadonlyArray<Record<string, unknown>> = [],
): TinybirdExecutorShape => ({
	orgId: "org_test",
	sqlQuery: (sql: string) => {
		captured.sqlQueries.push(sql)
		return Effect.succeed(sqlRows as ReadonlyArray<never>)
	},
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		return Effect.succeed({ data: pipeData as ReadonlyArray<never> })
	},
})

const makeLayer = (executor: TinybirdExecutorShape) => Layer.succeed(TinybirdExecutor, executor)

describe("findSlowTraces", () => {
	it.effect("issues ORDER BY Duration DESC at the DB (not in JS) with the requested limit", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				limit: 25,
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			assert.strictEqual(captured.sqlQueries.length, 1)
			const sql = captured.sqlQueries[0]!
			assert.match(sql, /ORDER BY Duration DESC/)
			assert.match(sql, /LIMIT 25/)
			assert.include(sql, "ParentSpanId = ''")
			assert.include(sql, "OrgId = 'org_test'")
			// Confirm we are NOT calling the list_traces pipe (old behavior)
			assert.isUndefined(captured.pipeCalls.find((c) => c.pipe === "list_traces"))
			// Stats pipe is still called
			assert.isTrue(captured.pipeCalls.some((c) => c.pipe === "traces_duration_stats"))
		}),
	)

	it.effect("adds service and environment filters when provided", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
				service: "api",
				environment: "production",
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			const sql = captured.sqlQueries[0]!
			assert.include(sql, "ServiceName = 'api'")
			assert.include(sql, "ResourceAttributes['deployment.environment'] = 'production'")
		}),
	)

	it.effect("defaults limit to 10 when not supplied", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }

			yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured))))

			assert.match(captured.sqlQueries[0]!, /LIMIT 10/)
		}),
	)

	it.effect("maps non-empty rows and stats into the FindSlowTracesOutput shape", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { sqlQueries: [], pipeCalls: [] }
			const executor = makeMockExecutor(
				captured,
				[
					{
						traceId: "trace-abc",
						spanName: "GET /api/users",
						serviceName: "api",
						durationMs: 1234,
						statusCode: "Ok",
						resourceAttributesStr: "{}",
						timestamp: "2026-04-01 12:00:00",
					},
				],
				[
					{
						minDurationMs: 5,
						maxDurationMs: 2000,
						p50DurationMs: 100,
						p95DurationMs: 1500,
					},
				],
			)

			const output = yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(executor)))

			assert.strictEqual(output.traces.length, 1)
			const trace = output.traces[0]!
			assert.strictEqual(trace.traceId, "trace-abc")
			assert.strictEqual(trace.spanId, null)
			assert.strictEqual(trace.spanName, "GET /api/users")
			assert.strictEqual(trace.serviceName, "api")
			assert.strictEqual(trace.durationMs, 1234)
			assert.strictEqual(trace.statusCode, "Ok")

			assert.isNotNull(output.stats)
			assert.strictEqual(output.stats!.p50Ms, 100)
			assert.strictEqual(output.stats!.p95Ms, 1500)
			assert.strictEqual(output.stats!.minMs, 5)
			assert.strictEqual(output.stats!.maxMs, 2000)
		}),
	)

	it.effect("propagates ObservabilityError from the executor", () =>
		Effect.gen(function* () {
			const failingExecutor: TinybirdExecutorShape = {
				orgId: "org_test",
				sqlQuery: () =>
					Effect.fail(
						new ObservabilityError({
							message: "ClickHouse exploded",
							category: "upstream",
						}),
					),
				query: () => Effect.succeed({ data: [] }),
			}

			const error = yield* findSlowTraces({
				timeRange: { startTime: "2026-04-01 00:00:00", endTime: "2026-04-02 00:00:00" },
			}).pipe(Effect.provide(makeLayer(failingExecutor)), Effect.flip)

			assert.instanceOf(error, ObservabilityError)
			assert.strictEqual(error.message, "ClickHouse exploded")
			assert.strictEqual(error.category, "upstream")
		}),
	)
})
