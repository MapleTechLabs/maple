// An alert evaluates the sliding window [end - W, end) at every tick, with `end`
// on a minute, not on a multiple of W. These run the real evaluate path against
// ClickHouse at a tick that is NOT W-aligned and compare it with the window's rows.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { Effect, Schema } from "effect"
import { MetricName, OrgId, ServiceName, UserId } from "@maple/domain"
import { baselineWarehouseCapabilities, type QuerySpec } from "@maple/query-engine"
import { type AlertEvaluateRequest, makeQueryEngineEvaluate } from "@maple/query-engine/runtime"
import { compiledQueryOf, normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import type { TenantContext } from "@maple/backend/services/auth/AuthService"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_alert_window_e2e")

const tenant: TenantContext = {
	orgId: Schema.decodeUnknownSync(OrgId)("org_alert_window"),
	userId: Schema.decodeUnknownSync(UserId)("user_alert_window"),
	roles: [],
	authMode: "self_hosted",
}

const asMetricName = Schema.decodeUnknownSync(MetricName)
const asServiceName = Schema.decodeUnknownSync(ServiceName)

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000
const MINUTE_MS = 60_000

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

// Anchored to now so the 30-day TTL never drops the seed. The tick is 10:03,
// which is not a multiple of 5 minutes or of 60.
const BASE_MS = Math.floor((Date.now() - 3 * DAY_MS) / DAY_MS) * DAY_MS
const TICK_MS = BASE_MS + 10 * HOUR_MS + 3 * MINUTE_MS
const at = (hour: number, minute: number, second = 0) =>
	BASE_MS + hour * HOUR_MS + minute * MINUTE_MS + second * 1000

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

const decodeJsonRows = Schema.decodeUnknownSync(
	Schema.fromJsonString(
		Schema.Struct({ data: Schema.Array(Schema.Record(Schema.String, Schema.Unknown)) }),
	),
)

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(normalizeSqlForClickHouseClient(sql), database, {
		default_format: "JSON",
		output_format_json_quote_64bit_integers: "0",
	})
	return decodeJsonRows(body).data
}

const runRows = (sql: string) => Effect.promise(() => runJson(sql))

const evaluate = makeQueryEngineEvaluate({
	rawSqlQuery: (_tenant, sql) => runRows(sql),
	compiledQuery: (_tenant, compiled) =>
		runRows(compiledQueryOf(compiled).sql).pipe(
			Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
		),
	compiledQueryWithCapabilities: (_tenant, compile) =>
		compile(baselineWarehouseCapabilities()).pipe(
			Effect.orDie,
			Effect.flatMap((compiled) =>
				runRows(compiledQueryOf(compiled).sql).pipe(
					Effect.flatMap((rows) => compiledQueryOf(compiled).decodeRows(rows).pipe(Effect.orDie)),
				),
			),
		),
})

/** The request the scheduler builds at `TICK_MS` for a `windowMinutes` rule. */
const tickRequest = (windowMinutes: number, query: QuerySpec): AlertEvaluateRequest => ({
	startTime: chDateTime(TICK_MS - windowMinutes * MINUTE_MS),
	endTime: chDateTime(TICK_MS),
	reducer: "identity",
	sampleCountStrategy: "trace_count",
	source: { kind: "spec", query },
})

interface SeedLog {
	readonly ms: number
	readonly service: string
}

// `logs5` rows straddle the 10:00 epoch boundary inside [09:58, 10:03);
// `logs60` rows sit in [09:03, 10:03), which holds no whole hour. Every source
// also gets a row at exactly the tick, which the half-open window excludes.
const SEED_LOGS: ReadonlyArray<SeedLog> = [
	{ ms: at(9, 57, 30), service: "logs5" },
	{ ms: at(9, 58, 10), service: "logs5" },
	{ ms: at(9, 59, 10), service: "logs5" },
	...Array.from({ length: 6 }, (_, i) => ({ ms: at(10, 0, 10 + i * 20), service: "logs5" })),
	{ ms: at(10, 3), service: "logs5" },
	{ ms: at(10, 3, 30), service: "logs5" },
	{ ms: at(9, 2), service: "logs60" },
	...Array.from({ length: 3 }, (_, i) => ({ ms: at(9, 10 + i), service: "logs60" })),
	...Array.from({ length: 2 }, (_, i) => ({ ms: at(9, 50 + i), service: "logs60" })),
	...Array.from({ length: 4 }, (_, i) => ({ ms: at(10, 1, i * 10), service: "logs60" })),
]

interface SeedSpan {
	readonly ms: number
	readonly status: "Ok" | "Error"
	readonly service?: string
}

// One error in the older part of the window and nine OKs in the newer part:
// the window's error rate is 0.1, while either epoch bucket alone reads 1 or 0.
const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	{ ms: at(9, 58, 30), status: "Error" },
	...Array.from({ length: 9 }, (_, i) => ({ ms: at(10, 0, 10 + i * 15), status: "Ok" as const })),
	{ ms: at(9, 57, 0), status: "Error" },
	{ ms: at(10, 3), status: "Error" },
	// `hourly` spans fill [08:03, 10:03): both partial edge hours and the whole
	// 09:00 hour that the hourly rollups answer, plus one row outside each end.
	...[at(8, 1), at(8, 10), at(9, 30), at(9, 31), at(9, 32), at(10, 1), at(10, 3), at(10, 4)].map((ms) => ({
		ms,
		status: "Ok" as const,
		service: "hourly",
	})),
]

// A gauge at 100 in the older part of the window and 0 in the newer part (avg 10),
// and a cumulative counter rising by 10 every 30s (10 samples fall in [09:58, 10:03)).
const GAUGE_POINTS: ReadonlyArray<{ readonly ms: number; readonly value: number }> = [
	{ ms: at(9, 58, 30), value: 100 },
	...Array.from({ length: 9 }, (_, i) => ({ ms: at(10, 0, 10 + i * 15), value: 0 })),
	{ ms: at(10, 3), value: 1000 },
]
const COUNTER_POINTS = Array.from({ length: 16 }, (_, i) => ({ ms: at(9, 56) + i * 30_000, value: 10 * i }))
// A sparse span-metrics counter: its sample before the 09:03 window start is
// 61 minutes old, older than one bucket of lookback.
const SPARSE_CALLS_POINTS = [
	{ ms: at(8, 2), value: 100 },
	{ ms: at(9, 10), value: 120 },
]

// Product events in the window: one before the 10:00 boundary and three after it.
const EVENT_TIMES = [at(9, 57), at(9, 59), at(10, 0, 30), at(10, 1), at(10, 2, 30), at(10, 3)]

const seed = async (): Promise<void> => {
	const logRows = SEED_LOGS.map(
		(row) =>
			`(${quote(tenant.orgId)}, ${quote(chDateTime(row.ms))}, ${quote(chDateTime(row.ms))}, '', '', 0, 'INFO', 9, ${quote(row.service)}, 'hello', '', map(), '', '', '', map(), map())`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO logs (
  OrgId, Timestamp, TimestampTime, TraceId, SpanId, TraceFlags,
  SeverityText, SeverityNumber, ServiceName, Body,
  ResourceSchemaUrl, ResourceAttributes,
  ScopeSchemaUrl, ScopeName, ScopeVersion, ScopeAttributes, LogAttributes
) VALUES\n${logRows}`,
		database,
	)

	const spanRows = SEED_SPANS.map(
		(row, index) =>
			`(${quote(tenant.orgId)}, ${quote(chDateTime(row.ms))}, ${quote(`trace-${index}`)}, ${quote(`span-${index}`)}, '', 'GET /x', 'Server', ${quote(row.service ?? "api")}, 120000000, ${quote(row.status)}, 1)`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate)
		 VALUES\n${spanRows}`,
		database,
	)

	const gaugeRows = GAUGE_POINTS.map(
		(row) =>
			`(${quote(tenant.orgId)}, 'api', 'queue.depth', ${quote(chDateTime(row.ms))}, ${quote(chDateTime(row.ms))}, ${row.value})`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO metrics_gauge (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value) VALUES\n${gaugeRows}`,
		database,
	)
	const counterRows = [
		...COUNTER_POINTS.map((row) => ({ ...row, name: "http.requests" })),
		...SPARSE_CALLS_POINTS.map((row) => ({ ...row, name: "span.metrics.calls" })),
	]
		.map(
			(row) =>
				`(${quote(tenant.orgId)}, 'api', ${quote(row.name)}, ${quote(chDateTime(at(8, 0)))}, ${quote(chDateTime(row.ms))}, ${row.value}, 2, true)`,
		)
		.join(",\n")
	await clickhouseExec(
		`INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic) VALUES\n${counterRows}`,
		database,
	)

	const eventRows = EVENT_TIMES.map(
		(ms) =>
			`(${quote(tenant.orgId)}, ${quote(chDateTime(ms))}, 'server', 'u1', 'custom', 'checkout', 'api', map())`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO product_events (OrgId, Timestamp, Source, UserId, Kind, EventName, ServiceName, Attributes) VALUES\n${eventRows}`,
		database,
	)
}

const valueAt = (request: AlertEvaluateRequest) =>
	evaluate(tenant, request).pipe(Effect.map((observations) => observations.map((obs) => obs.value)))

describe.skipIf(!clickhouseE2eEnabled)("alert evaluation at a tick that is not window-aligned", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await seed()
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it.effect("counts every log in a 5-minute window that crosses an epoch bucket", () =>
		Effect.gen(function* () {
			const values = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "logs",
					metric: "count",
					filters: { serviceName: asServiceName("logs5") },
					bucketSeconds: 300,
				}),
			)
			assert.deepStrictEqual(values, [8])
		}),
	)

	it.effect("counts every log in a 60-minute window that holds no whole hour", () =>
		Effect.gen(function* () {
			const values = yield* valueAt(
				tickRequest(60, {
					kind: "timeseries",
					source: "logs",
					metric: "count",
					filters: { serviceName: asServiceName("logs60") },
					bucketSeconds: 3600,
				}),
			)
			assert.deepStrictEqual(values, [9])
		}),
	)

	it.effect("computes a trace error rate over the whole window, not one side of it", () =>
		Effect.gen(function* () {
			const raw = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "traces",
					metric: "error_rate",
					filters: { serviceName: asServiceName("api") },
					bucketSeconds: 300,
				}),
			)
			const rootOnly = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "traces",
					metric: "error_rate",
					filters: { serviceName: asServiceName("api"), rootSpansOnly: true },
					bucketSeconds: 300,
				}),
			)
			assert.deepStrictEqual(raw, [0.1])
			assert.deepStrictEqual(rootOnly, [0.1])
		}),
	)

	it.effect("averages a gauge and sums a counter's increase over the whole window", () =>
		Effect.gen(function* () {
			const gauge = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "metrics",
					metric: "avg",
					filters: { metricName: asMetricName("queue.depth"), metricType: "gauge" },
					bucketSeconds: 300,
				}),
			)
			const increase = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "metrics",
					metric: "increase",
					filters: { metricName: asMetricName("http.requests"), metricType: "sum" },
					bucketSeconds: 300,
				}),
			)
			assert.deepStrictEqual(gauge, [10])
			assert.deepStrictEqual(increase, [100])
		}),
	)

	it.effect("divides a counter's window increase by the window, not a smaller stored bucket", () =>
		Effect.gen(function* () {
			const rate = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "metrics",
					metric: "rate",
					filters: { metricName: asMetricName("http.requests"), metricType: "sum" },
					bucketSeconds: 60,
				}),
			)
			assert.deepStrictEqual(rate, [100 / 300])
		}),
	)

	it.effect("keeps a sparse hourly counter's first in-window increase", () =>
		Effect.gen(function* () {
			const increase = yield* valueAt(
				tickRequest(60, {
					kind: "timeseries",
					source: "metrics",
					metric: "increase",
					filters: { metricName: asMetricName("span.metrics.calls"), metricType: "sum" },
					bucketSeconds: 3600,
				}),
			)
			assert.deepStrictEqual(increase, [20])
		}),
	)

	it.effect("counts every product event in the window", () =>
		Effect.gen(function* () {
			const values = yield* valueAt(
				tickRequest(5, {
					kind: "timeseries",
					source: "product_events",
					metric: "count",
					filters: { eventNames: ["checkout"] },
					bucketSeconds: 300,
				}),
			)
			assert.deepStrictEqual(values, [4])
		}),
	)

	it.effect("reduces a raw SQL rule that uses $__timeGroup over the whole window", () =>
		Effect.gen(function* () {
			const values = yield* valueAt({
				...tickRequest(5, { kind: "timeseries", source: "logs", metric: "count" }),
				source: {
					kind: "raw_sql",
					windowMinutes: 5,
					sql: "SELECT $__timeGroup(Timestamp) AS bucket, count() AS value FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp) AND ServiceName = 'logs5' GROUP BY bucket ORDER BY bucket",
				},
			})
			assert.deepStrictEqual(values, [8])
		}),
	)

	it.effect("keeps $__timeGroup row-based when a raw SQL rule filters on it", () =>
		Effect.gen(function* () {
			// $__timeFilter bounds only the subquery, so the outer rows outside the
			// window (09:57:30, 10:03, 10:03:30) are dropped only by a row-based macro.
			const values = yield* valueAt({
				...tickRequest(5, { kind: "timeseries", source: "logs", metric: "count" }),
				source: {
					kind: "raw_sql",
					windowMinutes: 5,
					sql: "SELECT $__timeGroup(Timestamp) AS bucket, count() AS value FROM logs WHERE $__orgFilter AND ServiceName = 'logs5' AND $__timeGroup(Timestamp) = $__startTime AND TraceId IN (SELECT TraceId FROM logs WHERE $__orgFilter AND $__timeFilter(Timestamp)) GROUP BY bucket ORDER BY bucket",
				},
			})
			assert.deepStrictEqual(values, [8])
		}),
	)

	it.effect("counts a 2-hour window across the raw edges and the hourly rollups", () =>
		Effect.gen(function* () {
			const allSpans = yield* valueAt(
				tickRequest(120, {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					filters: { serviceName: asServiceName("hourly") },
					bucketSeconds: 7200,
				}),
			)
			const rootOnly = yield* valueAt(
				tickRequest(120, {
					kind: "timeseries",
					source: "traces",
					metric: "count",
					filters: { serviceName: asServiceName("hourly"), rootSpansOnly: true },
					bucketSeconds: 7200,
				}),
			)
			assert.deepStrictEqual(allSpans, [5])
			assert.deepStrictEqual(rootOnly, [5])
		}),
	)
})
