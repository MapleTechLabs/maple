// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// `trace_facets_hourly` is cascaded off `trace_list_mv`: it fires on the insert
// blocks another view writes, not on `traces`, and a rollup nobody fills reads
// as "no data" rather than as an error. So this proves rows: spans inserted
// into `traces` on a database built from the real migration chain must roll up
// to exactly what `trace_list_mv` holds, and migration 0034's backfill must
// rebuild the same rollup from `trace_list_mv` alone.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { migrations, renderStatementFull } from "@maple/domain/clickhouse"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_trace_facets_e2e")
const ORG_ID = "org_trace_facets_e2e"

// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const HOUR_MS = 3_600_000
const BASE_MS = Math.floor((Date.now() - 4 * HOUR_MS) / HOUR_MS) * HOUR_MS

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)

interface SeedSpan {
	readonly traceId: string
	readonly ms: number
	readonly service: string
	readonly durationNs: number
	readonly parentSpanId?: string
	readonly status?: string
	readonly env?: string
}

const root = (traceId: string, ms: number, service: string, durationNs: number, extra = {}): SeedSpan => ({
	traceId,
	ms,
	service,
	durationNs,
	env: "production",
	...extra,
})

// Two insert blocks share the (hour, api, production) group, so the rollup holds
// two partial rows for it until a merge and reads must sum them.
const BATCH_1: ReadonlyArray<SeedSpan> = [
	root("t1", BASE_MS + 60_000, "api", 5_000_000),
	root("t2", BASE_MS + 120_000, "api", 9_000_000),
	root("t3", BASE_MS + 180_000, "worker", 1_000_000, { status: "Error", env: "staging" }),
	root("t4", BASE_MS + HOUR_MS + 60_000, "api", 2_000_000),
	// Not a root span: never reaches trace_list_mv, so never the rollup.
	{ traceId: "t1", ms: BASE_MS + 61_000, service: "api", durationNs: 1_000, parentSpanId: "root-t1" },
]
const BATCH_2: ReadonlyArray<SeedSpan> = [root("t5", BASE_MS + 240_000, "api", 3_000_000)]

const insert = async (spans: ReadonlyArray<SeedSpan>): Promise<void> => {
	const rows = spans
		.map(
			(span, index) =>
				`('${ORG_ID}', '${chDateTime(span.ms)}', '${span.traceId}', 'span-${span.traceId}-${index}', '${span.parentSpanId ?? ""}', 'op', 'Server', '${span.service}', ${span.durationNs}, '${span.status ?? "Ok"}', '', 1, map(), map('deployment.environment.name', '${span.env ?? ""}'))`,
		)
		.join("\n,")
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const runJson = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const DIMENSIONS =
	"Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode, DeploymentEnv, ServiceNamespace, HasError"

const fromTraceList = () =>
	runJson(
		`SELECT toString(toStartOfHour(Timestamp)) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode,
		        DeploymentEnv, ServiceNamespace, HasError,
		        count() AS traces, min(Duration) AS durationMin, max(Duration) AS durationMax
		 FROM trace_list_mv WHERE OrgId = '${ORG_ID}'
		 GROUP BY ${DIMENSIONS} ORDER BY ${DIMENSIONS}`,
	)

const fromRollup = () =>
	runJson(
		`SELECT toString(Hour) AS Hour, ServiceName, SpanName, HttpMethod, HttpStatusCode,
		        DeploymentEnv, ServiceNamespace, HasError,
		        sum(TraceCount) AS traces, min(DurationMin) AS durationMin, max(DurationMax) AS durationMax
		 FROM trace_facets_hourly WHERE OrgId = '${ORG_ID}'
		 GROUP BY ${DIMENSIONS} ORDER BY ${DIMENSIONS}`,
	)

describe.skipIf(!clickhouseE2eEnabled)("trace_facets_hourly materialization", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(BATCH_1)
		await insert(BATCH_2)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("rolls up every root span of trace_list_mv, live and from migration 0034's backfill", async () => {
		const expected = await fromTraceList()
		assert.strictEqual(
			expected.reduce((total, row) => total + Number(row.traces), 0),
			5,
		)
		assert.deepStrictEqual(await fromRollup(), expected)

		const backfill = migrations
			.find((migration) => migration.version === 34)!
			.statements.find((statement) => typeof statement !== "string")!
		await clickhouseExec("TRUNCATE TABLE trace_facets_hourly", database)
		await clickhouseExec(renderStatementFull(backfill, database), database)
		assert.deepStrictEqual(await fromRollup(), expected)
	})
})
