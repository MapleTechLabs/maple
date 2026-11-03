import { assert, describe, it } from "@effect/vitest"
import { Effect, Array as Arr, String as Str } from "effect"
import { OrgId } from "@maple/domain/http"
import { WarehouseQuotaExceededError } from "@maple/domain/http/warehouse-errors"
import { searchTraces } from "./search-traces"
import { WarehouseExecutor, type WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

const TRACE_ID = "0af7651916cd43dd8448eb211c80319c"

const spanRow = (n: number, timestamp: string) => ({
	traceId: TRACE_ID,
	spanId: Str.padStart(16, "0")(n.toString(16)),
	spanName: "checkout",
	serviceName: "api",
	durationMs: 5,
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: {},
	resourceAttributes: {},
	timestamp,
})

interface Call {
	readonly startTime: unknown
	readonly endTime: unknown
	readonly limit: unknown
}

/** `span_search` answering by window: `recent` for the newest hour, `older` for the rest. */
const makeExecutor = (
	calls: Array<Call>,
	answers: {
		readonly recent: ReadonlyArray<unknown>
		readonly older: ReadonlyArray<unknown> | "timeout"
	},
): WarehouseExecutorApi => ({
	orgId: OrgId.make("org_test"),
	compiledQuery: (compiled) => compiledQueryOf(compiled).decodeRows([]).pipe(Effect.orDie),
	compiledQueryFirst: (compiled) => compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
	query: (_pipe, params) => {
		calls.push({ startTime: params.start_time, endTime: params.end_time, limit: params.limit })
		const isRecent = params.end_time === "2026-04-01 06:00:00" && calls.length === 1
		if (isRecent) return Effect.succeed({ data: answers.recent as ReadonlyArray<never> })
		return answers.older === "timeout"
			? Effect.fail(
					new WarehouseQuotaExceededError({
						message: "span_search ran past its time limit",
						pipeName: "span_search",
						setting: "max_execution_time",
					}),
				)
			: Effect.succeed({ data: answers.older as ReadonlyArray<never> })
	},
})

const sixHours = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-01 06:00:00" }

const run = (executor: WarehouseExecutorApi, input: Partial<Parameters<typeof searchTraces>[0]> = {}) =>
	searchTraces({ timeRange: sixHours, spanName: "checkout", limit: 2, ...input }).pipe(
		Effect.provideService(WarehouseExecutor, executor),
	)

describe("searchTraces by span name", () => {
	it.effect("answers from the newest hour alone when it fills the page", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			const result = yield* run(
				makeExecutor(calls, {
					recent: [spanRow(1, "2026-04-01 05:59:00"), spanRow(2, "2026-04-01 05:30:00")],
					older: [],
				}),
			)
			assert.lengthOf(calls, 1)
			assert.deepStrictEqual(calls[0], {
				startTime: "2026-04-01 05:00:00",
				endTime: "2026-04-01 06:00:00",
				limit: 2,
			})
			assert.lengthOf(result.spans, 2)
			assert.isTrue(result.pagination.hasMore)
			assert.isUndefined(result.coveredFrom)
		}),
	)

	it.effect("reads the older part for what the newest hour lacks, once per span", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			const boundary = spanRow(2, "2026-04-01 05:00:00")
			const result = yield* run(
				makeExecutor(calls, {
					recent: [spanRow(1, "2026-04-01 05:10:00"), boundary],
					older: [boundary, spanRow(3, "2026-04-01 04:00:00")],
				}),
				{ limit: 3 },
			)
			assert.lengthOf(calls, 2)
			assert.deepStrictEqual(calls[1], {
				startTime: "2026-04-01 00:00:00",
				endTime: "2026-04-01 05:00:00",
				// One over what is missing, so the span at the shared bound cannot short the page.
				limit: 2,
			})
			assert.deepStrictEqual(
				Arr.map(result.spans, (span) => String(span.spanId)),
				["0000000000000001", "0000000000000002", "0000000000000003"],
			)
		}),
	)

	it.effect("pages with offset across both parts", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			const result = yield* run(
				makeExecutor(calls, {
					recent: [spanRow(1, "2026-04-01 05:10:00")],
					older: [spanRow(2, "2026-04-01 04:00:00"), spanRow(3, "2026-04-01 03:00:00")],
				}),
				{ limit: 2, offset: 1 },
			)
			assert.deepStrictEqual(
				Arr.map(result.spans, (span) => String(span.spanId)),
				["0000000000000002", "0000000000000003"],
			)
		}),
	)

	it.effect("pages a deep offset in one SQL query over the whole window", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			yield* run(makeExecutor(calls, { recent: [], older: [] }), { limit: 2, offset: 40 })
			assert.lengthOf(calls, 1)
			assert.deepStrictEqual(calls[0], {
				startTime: "2026-04-01 00:00:00",
				endTime: "2026-04-01 06:00:00",
				limit: 2,
			})
		}),
	)

	it.effect("returns the newest hour with coveredFrom when the older part runs out of time", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			const result = yield* run(
				makeExecutor(calls, { recent: [spanRow(1, "2026-04-01 05:10:00")], older: "timeout" }),
			)
			assert.lengthOf(result.spans, 1)
			assert.strictEqual(result.coveredFrom, "2026-04-01 05:00:00")
		}),
	)

	it.effect("reads a window of an hour or less, or one trace, in one query", () =>
		Effect.gen(function* () {
			const calls: Array<Call> = []
			const executor = makeExecutor(calls, { recent: [], older: [] })
			yield* run(executor, {
				timeRange: { startTime: "2026-04-01 05:30:00", endTime: "2026-04-01 06:00:00" },
			})
			yield* run(executor, { traceId: TRACE_ID })
			assert.lengthOf(calls, 2)
			assert.strictEqual(calls[1]!.startTime, "2026-04-01 00:00:00")
		}),
	)
})
