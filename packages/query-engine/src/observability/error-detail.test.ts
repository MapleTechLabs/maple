import { assert, describe, it } from "@effect/vitest"
import { Effect, Layer } from "effect"
import { errorDetail } from "./error-detail"
import { WarehouseExecutor } from "./WarehouseExecutor"
import type { WarehouseExecutorApi } from "./WarehouseExecutor"
import { compiledQueryOf } from "../execution/compiled-input"

interface CapturedCalls {
	pipeCalls: Array<{ pipe: string; params: Record<string, unknown> }>
}

const traceRow = (traceId: string, startTime: string) => ({
	traceId,
	startTime,
	durationMicros: 1000,
	spanCount: 3,
	services: ["api"],
	rootSpanName: "GET /",
	errorMessage: "boom",
	errorSpanId: "span-err",
	errorSpanName: "chat gpt-x",
	errorServiceName: "api",
	errorModel: "gpt-x",
	errorToolName: "",
	errorHttpMethod: "",
	errorHttpRoute: "",
	errorQueryContext: "",
	errorType: "",
	errorLabel: "RateLimitError",
	exceptionType: "RateLimitError",
	exceptionMessage: "429 from gpt-x",
})

/** Rows for compiled (non-pipe) reads, routed by the context name a query runs under. */
type CompiledRows = Partial<Record<string, ReadonlyArray<Record<string, unknown>>>>

const makeMockExecutor = (
	captured: CapturedCalls,
	tracesData: ReadonlyArray<unknown>,
	compiledRows: CompiledRows = {},
	logsData: ReadonlyArray<unknown> = [],
): WarehouseExecutorApi => ({
	orgId: "org_test",
	compiledQuery: (compiled, options) => {
		const query = compiledQueryOf(compiled)
		captured.pipeCalls.push({ pipe: options?.context ?? "compiled", params: { sql: query.sql } })
		return query.decodeRows(compiledRows[options?.context ?? ""] ?? []).pipe(Effect.orDie)
	},
	compiledQueryFirst: (compiled) => compiledQueryOf(compiled).decodeFirstRow([]).pipe(Effect.orDie),
	query: (pipe: string, params: Record<string, unknown>) => {
		captured.pipeCalls.push({ pipe, params })
		return Effect.succeed({
			data: (pipe === "error_detail_traces"
				? tracesData
				: pipe === "list_logs"
					? logsData
					: []) as ReadonlyArray<never>,
		})
	},
})

const makeLayer = (executor: WarehouseExecutorApi) => Layer.succeed(WarehouseExecutor, executor)

const timeRange = { startTime: "2026-04-01 00:00:00", endTime: "2026-04-08 00:00:00" }

describe("errorDetail", () => {
	it.effect("bounds each per-trace list_logs call to ±1h around the trace start", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* errorDetail({
				fingerprintHash: "123",
				timeRange,
			}).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00.123")])),
				),
			)

			const logs = captured.pipeCalls.filter((c) => c.pipe === "list_logs")
			assert.lengthOf(logs, 1)
			// Without an explicit range, pipe-dispatch falls back to an all-time
			// sentinel window (2023→2099) and the lookup scans full retention.
			assert.strictEqual(logs[0]!.params.start_time, "2026-04-03 11:00:00")
			assert.strictEqual(logs[0]!.params.end_time, "2026-04-03 13:00:00")
		}),
	)

	it.effect("falls back to the input time range when the trace start is unparseable", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }

			yield* errorDetail({
				fingerprintHash: "123",
				timeRange,
			}).pipe(Effect.provide(makeLayer(makeMockExecutor(captured, [traceRow("t1", "not-a-date")]))))

			const logs = captured.pipeCalls.filter((c) => c.pipe === "list_logs")
			assert.lengthOf(logs, 1)
			assert.strictEqual(logs[0]!.params.start_time, timeRange.startTime)
			assert.strictEqual(logs[0]!.params.end_time, timeRange.endTime)
		}),
	)

	it.effect("surfaces the failing span with only the attributes it carries", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00")])),
				),
			)
			const span = result.traces[0]!.errorSpan
			assert.isDefined(span)
			assert.strictEqual(span!.name, "chat gpt-x")
			assert.strictEqual(span!.statusMessage, "boom")
			assert.deepStrictEqual(span!.attributes, { "gen_ai.request.model": "gpt-x" })
		}),
	)

	it.effect("names the error the sampled traces belong to", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00")])),
				),
			)
			assert.deepStrictEqual(result.error, {
				label: "RateLimitError",
				exceptionType: "RateLimitError",
				message: "429 from gpt-x",
				serviceName: "api",
			})
		}),
	)

	it.effect("leaves the error unnamed when no trace was sampled", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured, []))),
			)
			assert.isUndefined(result.error)
		}),
	)

	const summaryRow = (overrides: Record<string, unknown> = {}) => ({
		occurrences: 42,
		firstSeen: "2026-04-01 03:00:00",
		lastSeen: "2026-04-02 10:00:00",
		errorLabel: "Unknown Error",
		exceptionType: "",
		exceptionMessage: "",
		statusMessage: "{}",
		serviceCount: 1,
		services: ["landing"],
		noExceptionCount: 42,
		...overrides,
	})

	it.effect("anchors the sample window on the fingerprint's last occurrence", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({
				fingerprintHash: "123",
				timeRange: { startTime: "2026-04-08 00:00:00", endTime: "2026-04-08 06:00:00" },
				anchorWithin: { startTime: "2026-03-09 06:00:00", endTime: "2026-04-08 06:00:00" },
			}).pipe(
				Effect.provide(
					makeLayer(makeMockExecutor(captured, [], { errorFingerprintSummary: [summaryRow()] })),
				),
			)
			const traces = captured.pipeCalls.find((c) => c.pipe === "error_detail_traces")
			assert.strictEqual(traces!.params.start_time, "2026-04-02 04:00:00")
			assert.strictEqual(traces!.params.end_time, "2026-04-02 10:01:00")
			assert.isTrue(result.anchored)
			assert.strictEqual(result.summary?.occurrences, 42)
			assert.deepStrictEqual(result.summary?.services, ["landing"])
		}),
	)

	it.effect("keeps an explicit window and still names the error from error_events", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(
					makeLayer(
						makeMockExecutor(captured, [], {
							errorFingerprintSummary: [
								summaryRow({ exceptionType: "TypeError", errorLabel: "TypeError" }),
							],
						}),
					),
				),
			)
			const traces = captured.pipeCalls.find((c) => c.pipe === "error_detail_traces")
			assert.strictEqual(traces!.params.start_time, timeRange.startTime)
			assert.isFalse(result.anchored)
			// "{}" is no message at all; the identity says so by leaving it empty.
			assert.deepStrictEqual(result.error, {
				label: "TypeError",
				exceptionType: "TypeError",
				message: "",
				serviceName: "landing",
			})
		}),
	)

	it.effect("labels an exception-less error by its span and lists error logs first", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const row = {
				...traceRow("t1", "2026-04-03 12:00:00"),
				errorLabel: "Unknown Error",
				exceptionType: "",
				exceptionMessage: "",
				errorMessage: "",
				errorSpanName: "GET /api/org",
				errorModel: "",
				errorHttpMethod: "GET",
				errorHttpRoute: "",
				errorHttpStatus: "404",
			}
			const logs = [
				{ timestamp: "2026-04-03 12:00:03", severityText: "Info", body: "Tool completed" },
				{ timestamp: "2026-04-03 12:00:01", severityText: "Error", body: "lookup failed" },
			]
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(makeLayer(makeMockExecutor(captured, [row], {}, logs))),
			)
			assert.strictEqual(result.error?.label, "GET 404 /api/org")
			assert.deepStrictEqual(
				result.traces[0]!.logs.map((l) => l.body),
				["lookup failed", "Tool completed"],
			)
			assert.strictEqual(result.traces[0]!.errorSpan?.attributes["http.response.status_code"], "404")
		}),
	)

	it.effect("names fingerprints that fire in the same traces", () =>
		Effect.gen(function* () {
			const captured: CapturedCalls = { pipeCalls: [] }
			const result = yield* errorDetail({ fingerprintHash: "123", timeRange }).pipe(
				Effect.provide(
					makeLayer(
						makeMockExecutor(captured, [traceRow("t1", "2026-04-03 12:00:00")], {
							errorCooccurringFingerprints: [
								{
									fingerprintHash: "999",
									errorLabel: "OtlpIngestError",
									serviceName: "api",
									traces: 1,
									count: 1,
								},
							],
						}),
					),
				),
			)
			assert.deepStrictEqual(result.related, [
				{ fingerprintHash: "999", label: "OtlpIngestError", serviceName: "api", traces: 1 },
			])
			const related = captured.pipeCalls.find((c) => c.pipe === "errorCooccurringFingerprints")
			assert.include(String(related!.params.sql), "'t1'")
		}),
	)
})
