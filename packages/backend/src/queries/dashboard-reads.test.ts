import { describe, expect, it } from "@effect/vitest"
import { DateTime, Effect, Fiber, Option, Ref, Schema } from "effect"
import { TestClock } from "effect/testing"
import { ServiceOperationsRequest, WarehouseConfigError } from "@maple/domain/http"
import { OrgId, UserId } from "@maple/domain/primitives"
import { compiledQueryOf, type CompiledQueryInput } from "@maple/query-engine/execution"
import { makeRecordingTracer, spansNamed } from "@maple/backend/testing/recording-tracer"
import { makeWarehouseServiceStub } from "@maple/backend/testing/warehouse-test-support"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import type { QueryEngineServiceApi } from "@maple/backend/services/warehouse/QueryEngineService"
import { makeDashboardReads, withinBudget } from "./dashboard-reads"

const TRACE_ID = "7f3a4b5c6d7e8f901234567890abcdef"

const tenant: TenantContext = {
	orgId: Schema.decodeUnknownSync(OrgId)("org_dashboard_reads"),
	userId: Schema.decodeUnknownSync(UserId)("user_dashboard_reads"),
	roles: [],
	authMode: "self_hosted",
}

const spanRow = (spanId: string) => ({
	traceId: TRACE_ID,
	spanId,
	parentSpanId: "",
	spanName: "GET /checkout",
	rawSpanName: "http.server GET",
	serviceName: "api",
	spanKind: "Server",
	durationMs: 12,
	startTime: "2026-07-15 12:00:00.000",
	statusCode: "Ok",
	statusMessage: "",
	spanAttributes: "{}",
	resourceAttributes: "{}",
	relationship: "related",
})

const probeRow = (timestamp: string, endTimestamp: string) => ({ traceId: TRACE_ID, timestamp, endTimestamp })

type Rows = ReadonlyArray<Record<string, unknown>>

/** A warehouse answering from `rowsFor`, recording every statement it ran. */
const makeWarehouse = (rowsFor: (sql: string) => Effect.Effect<Rows, WarehouseConfigError>) => {
	const statements: string[] = []
	const decode = (compiled: CompiledQueryInput<unknown>) => {
		const query = compiledQueryOf(compiled)
		statements.push(query.sql)
		return rowsFor(query.sql).pipe(Effect.flatMap((rows) => query.decodeRows(rows).pipe(Effect.orDie)))
	}
	const warehouse = makeWarehouseServiceStub({
		// SAFETY: these reads hand the stub a plain compiled query, never a capability compile.
		compiledQuery: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled)) as never,
		// SAFETY: as above.
		compiledQueryFirst: ((_tenant: unknown, compiled: CompiledQueryInput<unknown>) =>
			decode(compiled).pipe(Effect.map((rows) => Option.fromNullishOr(rows[0])))) as never,
	})
	return { warehouse, statements }
}

/** Probes and hierarchy reads: the recent probe, the full probe, then the spans. */
const traceWarehouse = (options: {
	readonly recentProbe: Rows
	readonly fullProbe: Rows
	readonly spans: number
}) =>
	makeWarehouse((sql) => {
		if (sql.includes("AS relationship")) {
			return Effect.succeed(
				Array.from({ length: options.spans }, (_, index) =>
					spanRow(index.toString(16).padStart(16, "0")),
				),
			)
		}
		return Effect.succeed(sql.includes("MaxTimestamp >=") ? options.recentProbe : options.fullProbe)
	})

interface CacheCall {
	readonly route: string
	/** The TTL the write would get for the computed value, when the read sets one. */
	readonly ttlSeconds: number | undefined
}

/** The query engine as the reads see it: `cachedDirect` runs the compute and records the call. */
const makeQueryEngine = (
	calls: CacheCall[],
	wrap: <A, E>(effect: Effect.Effect<A, E>) => Effect.Effect<A, E> = (effect) => effect,
): QueryEngineServiceApi => ({
	execute: () => Effect.die("execute is not used by these reads"),
	evaluate: () => Effect.die("evaluate is not used by these reads"),
	evaluateSeries: () => Effect.die("evaluateSeries is not used by these reads"),
	cachedDirect: (_tenant, route, _payload, effect, _policy, _schema, ttlSecondsFor) =>
		wrap(effect).pipe(
			Effect.tap((value) =>
				Effect.sync(() => calls.push({ route, ttlSeconds: ttlSecondsFor?.(value) })),
			),
		),
})

const hierarchyStatement = (statements: ReadonlyArray<string>) =>
	statements.find((sql) => sql.includes("AS relationship"))

describe("makeDashboardReads.spanHierarchy", () => {
	it.effect("reads the caller's window without probing", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = traceWarehouse({ recentProbe: [], fullProbe: [], spans: 1 })
			const calls: CacheCall[] = []
			const result = yield* makeDashboardReads({
				warehouse,
				queryEngine: makeQueryEngine(calls),
			}).spanHierarchy(tenant, {
				traceId: TRACE_ID,
				startTime: "2026-07-15 11:30:00",
				endTime: "2026-07-15 12:30:00",
			})
			expect(result.rows).toHaveLength(1)
			expect(calls.map((call) => call.route)).toEqual(["spanHierarchy"])
			expect(statements).toHaveLength(1)
			expect(hierarchyStatement(statements)).toContain("'2026-07-15 11:30:00'")
		}),
	)

	it.effect("covers spans that start long after the root, an hour past the last one", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = traceWarehouse({
				recentProbe: [],
				fullProbe: [probeRow("2026-06-01 08:00:00", "2026-06-01 09:30:00")],
				spans: 1,
			})
			yield* makeDashboardReads({ warehouse, queryEngine: makeQueryEngine([]) }).spanHierarchy(tenant, {
				traceId: TRACE_ID,
			})
			expect(statements).toHaveLength(3)
			const hierarchy = hierarchyStatement(statements)
			expect(hierarchy).toContain("'2026-06-01 07:00:00'")
			expect(hierarchy).toContain("'2026-06-01 10:30:00'")
		}),
	)

	it.effect("asks the full probe when the recent one starts at its own cutoff", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-15T12:00:00Z")))
			const { warehouse, statements } = traceWarehouse({
				// The recent probe cannot see the rows before 2026-07-13 12:00.
				recentProbe: [probeRow("2026-07-13 12:05:00", "2026-07-13 12:20:00")],
				fullProbe: [probeRow("2026-07-13 11:00:00", "2026-07-13 12:20:00")],
				spans: 1,
			})
			yield* makeDashboardReads({ warehouse, queryEngine: makeQueryEngine([]) }).spanHierarchy(tenant, {
				traceId: TRACE_ID,
			})
			expect(statements).toHaveLength(3)
			expect(hierarchyStatement(statements)).toContain("'2026-07-13 10:00:00'")
		}),
	)

	it.effect("keeps a settled recent probe without the every-partition fallback", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-15T12:00:00Z")))
			const { warehouse, statements } = traceWarehouse({
				recentProbe: [probeRow("2026-07-15 10:00:00", "2026-07-15 10:05:00")],
				fullProbe: [],
				spans: 1,
			})
			yield* makeDashboardReads({ warehouse, queryEngine: makeQueryEngine([]) }).spanHierarchy(tenant, {
				traceId: TRACE_ID,
			})
			expect(statements).toHaveLength(2)
			expect(hierarchyStatement(statements)).toContain("'2026-07-15 11:05:00'")
		}),
	)

	it.effect("reads one sentinel span past the cap to report truncation", () =>
		Effect.gen(function* () {
			const { warehouse, statements } = traceWarehouse({ recentProbe: [], fullProbe: [], spans: 5001 })
			const result = yield* makeDashboardReads({
				warehouse,
				queryEngine: makeQueryEngine([]),
			}).spanHierarchy(tenant, { traceId: TRACE_ID })
			expect(result.truncated).toBe(true)
			expect(result.rows).toHaveLength(5000)
			// No probe hit, so the read stays unbounded rather than guessing a window.
			expect(hierarchyStatement(statements)).not.toContain("Timestamp >=")
		}),
	)

	it.effect("barely caches a trace not found yet, and settles a found one by its last span", () =>
		Effect.gen(function* () {
			yield* TestClock.setTime(DateTime.toEpochMillis(DateTime.makeUnsafe("2026-07-16T12:00:00Z")))
			const calls: CacheCall[] = []
			yield* Effect.forEach([0, 1], (spans) =>
				makeDashboardReads({
					warehouse: traceWarehouse({ recentProbe: [], fullProbe: [], spans }).warehouse,
					queryEngine: makeQueryEngine(calls),
				}).spanHierarchy(tenant, { traceId: TRACE_ID }),
			)
			// The found trace ended a day before "now", so it can no longer change.
			expect(calls.map((call) => call.ttlSeconds)).toEqual([1, 600])
		}),
	)
})

const missingRollup = new WarehouseConfigError({
	message: "Table service_operations_minutely does not exist",
	pipeName: "serviceOperations",
	clickhouseType: "UNKNOWN_TABLE",
})

const operationsPayload = Schema.decodeUnknownSync(ServiceOperationsRequest)({
	serviceName: "api",
	startTime: "2026-07-15 12:00:00",
	endTime: "2026-07-15 13:00:00",
	limit: 25,
})

describe("makeDashboardReads.serviceOperations", () => {
	it.effect("labels a rollup fallback on the caller's span, not the cache's", () =>
		Effect.gen(function* () {
			const { warehouse } = makeWarehouse((sql) => {
				if (sql.includes("service_operations_")) return Effect.fail(missingRollup)
				if (sql.includes("AS bucket")) return Effect.succeed([])
				return Effect.succeed([
					{
						spanName: "GET /checkout",
						spanCount: "8",
						estimatedSpanCount: "8",
						errorCount: "0",
						estimatedErrorCount: "0",
						errorRate: "0",
						avgDurationMs: "10",
						p50DurationMs: "9",
						p95DurationMs: "20",
						p99DurationMs: "30",
					},
				])
			})
			const { spans, tracer } = makeRecordingTracer()
			const queryEngine = makeQueryEngine([], (effect) => Effect.withSpan(effect, "cache"))
			const rows = yield* makeDashboardReads({ warehouse, queryEngine })
				.serviceOperations(tenant, operationsPayload)
				.pipe(Effect.withSpan("request"), Effect.withTracer(tracer))
			expect(rows.map((row) => row.spanName)).toEqual(["GET /checkout"])
			expect(spansNamed(spans, "request")[0]?.attributes.get("query.rollup.fallback")).toBe(true)
			expect(spansNamed(spans, "cache")[0]?.attributes.has("query.rollup.fallback")).toBe(false)
		}),
	)
})

describe("withinBudget", () => {
	const context = { orgId: "org_dashboard_reads", layer: "serviceDbEdges" }

	it.effect("passes a read that finishes inside its budget through", () =>
		Effect.gen(function* () {
			const result = yield* withinBudget(Effect.succeed(["edge"]), "12 seconds", [], context)
			expect(result).toEqual({ value: ["edge"], timedOut: false })
		}),
	)

	it.effect("interrupts a read past its budget and flags the empty stand-in", () =>
		Effect.gen(function* () {
			const interrupted = yield* Ref.make(false)
			const slow = Effect.sleep("30 seconds").pipe(
				Effect.as(["edge"]),
				Effect.onInterrupt(() => Ref.set(interrupted, true)),
			)
			const fiber = yield* Effect.forkChild(withinBudget(slow, "12 seconds", [], context))
			yield* TestClock.adjust("12 seconds")
			const result = yield* Fiber.join(fiber)
			expect(result).toEqual({ value: [], timedOut: true })
			expect(yield* Ref.get(interrupted)).toBe(true)
		}),
	)

	it.effect("still fails on a read that errors inside its budget", () =>
		Effect.gen(function* () {
			const failure = new WarehouseConfigError({ message: "bad route", pipeName: "serviceDbEdges" })
			const exit = yield* Effect.exit(withinBudget(Effect.fail(failure), "12 seconds", [], context))
			expect(exit._tag).toBe("Failure")
		}),
	)
})
