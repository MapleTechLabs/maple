import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema, Array as Arr, Record as Rec, String as Str } from "effect"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import type { MigrationModuleContext } from "../src/server/local-store-migration-module"
import { localSchemaSnapshot } from "../src/server/schema-snapshots"
import { describeWithChdb } from "./libchdb-test-support"
import { migrationStep, openStore } from "./local-store-step-test-support"

const HOUR_MS = 3_600_000
const MS_NS = 1_000_000
const iso = (ms: number) => Str.replace("Z", "")(Str.replace("T", " ")(new Date(ms).toISOString()))
const SPAN_COLUMNS =
	"OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanKind, ServiceName, Duration, StatusCode, SampleRate"

interface Span {
	readonly durationMs: number
	readonly sampleRate: number
	readonly status?: "Ok" | "Error"
	readonly parent?: string
	readonly kind?: "Server" | "Client"
}

const spanRows = (atMs: number, prefix: string, spans: ReadonlyArray<Span>) =>
	Arr.join(
		Arr.map(
			spans,
			(span, n) =>
				`('local', '${iso(atMs)}', '${prefix}-trace-${n}', '${prefix}-span-${n}', '${span.parent ?? ""}', '${span.kind ?? "Server"}', 'api', ${span.durationMs * MS_NS}, '${span.status ?? "Ok"}', ${span.sampleRate})`,
		),
		", ",
	)

const LADDER = [
	"EstimatedUnder50Ms",
	"EstimatedUnder100Ms",
	"EstimatedUnder250Ms",
	"EstimatedUnder500Ms",
	"EstimatedUnder1000Ms",
	"EstimatedUnder2500Ms",
	"EstimatedUnder5000Ms",
	"EstimatedUnder10000Ms",
] as const

// Entry-point spans, sampling-weighted. 500ms and 20s sit on/over a rung, and the
// 300ms error still counts: the ladder ignores status.
const POST_MIGRATION_SPANS: ReadonlyArray<Span> = [
	{ durationMs: 30, sampleRate: 1 },
	{ durationMs: 75, sampleRate: 2 },
	{ durationMs: 300, sampleRate: 1, status: "Error" },
	{ durationMs: 500, sampleRate: 4 },
	{ durationMs: 1200, sampleRate: 1 },
	{ durationMs: 20_000, sampleRate: 1 },
	// A non-root client span is not an entry point and never reaches the rollups.
	{ durationMs: 10, sampleRate: 100, kind: "Client", parent: "x" },
]

const decodeLadder = decodeJsonEachRow(
	Schema.Struct({
		spans: Schema.String,
		...Rec.fromEntries(Arr.map(LADDER, (column) => [column, Schema.String] as const)),
	}),
)

/** The ladder and span count of one rollup's buckets at or after `fromMs` and before `toMs`. */
const ladder = (
	db: Chdb,
	table: "service_overview_hourly" | "service_overview_minutely",
	fromMs: number,
	toMs: number,
) => {
	const time = table === "service_overview_hourly" ? "Hour" : "Minute"
	const sums = Arr.join(
		Arr.map(LADDER, (column) => `toString(sum(${column})) AS ${column}`),
		", ",
	)
	return decodeLadder(
		db.query(
			`SELECT toString(sum(SpanCount)) AS spans, ${sums} FROM ${table} WHERE OrgId = 'local' AND ${time} >= toDateTime('${iso(fromMs)}') AND ${time} < toDateTime('${iso(toMs)}')`,
		),
	)[0]
}

describeWithChdb("v49 -> v50 service-overview SLO latency ladder", () => {
	const STEP_ID = "local-0049-to-0050-service-overview-slo-latency-ladder"
	let migration: ReturnType<typeof migrationStep>["migration"]
	let root = ""
	let sourceDataDir = ""
	let targetDataDir = ""
	let context: MigrationModuleContext
	const nowMs = Date.now()
	const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
	const oldHourMs = currentHourMs - 3 * HOUR_MS

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-slo-latency-ladder-"))
		sourceDataDir = join(root, "source", "data")
		targetDataDir = join(root, "target", "data")
		const db = Chdb.open({ dataDir: sourceDataDir, schemaSql: localSchemaSnapshot(49).sql })
		db.exec(
			`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${spanRows(oldHourMs + 60_000, "old", [
				{ durationMs: 20, sampleRate: 1 },
				{ durationMs: 40, sampleRate: 1 },
			])}`,
		)
		db.close()
		;({ migration, context } = migrationStep(STEP_ID, sourceDataDir, targetDataDir, nowMs))
	})

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	test("keeps every existing bucket and reads the ladder as zero on them", async () => {
		const state = await migration.preflight(context)
		await migration.prepareTarget(context, state)
		const progress = await migration.apply(context, state, undefined)
		await migration.verify(context, state, progress)

		const old = await openStore(
			targetDataDir,
			(db) => ({
				hourly: ladder(db, "service_overview_hourly", oldHourMs, oldHourMs + HOUR_MS),
				minutely: ladder(db, "service_overview_minutely", oldHourMs, oldHourMs + HOUR_MS),
			}),
			{ schemaSql: localSchemaSnapshot(50).sql, bootstrapSchema: false },
		)
		const zeros = Rec.fromEntries(Arr.map(LADDER, (column) => [column, "0"] as const))
		expect(old.hourly).toEqual({ spans: "2", ...zeros })
		expect(old.minutely).toEqual({ spans: "2", ...zeros })
	})

	test("the recreated views count sampling-weighted entry-point spans strictly under each rung", async () => {
		const fresh = await openStore(
			targetDataDir,
			(db) => {
				db.exec(
					`INSERT INTO traces (${SPAN_COLUMNS}) VALUES ${spanRows(nowMs, "new", POST_MIGRATION_SPANS)}`,
				)
				return {
					hourly: ladder(db, "service_overview_hourly", currentHourMs, currentHourMs + HOUR_MS),
					minutely: ladder(db, "service_overview_minutely", currentHourMs, currentHourMs + HOUR_MS),
				}
			},
			{ schemaSql: localSchemaSnapshot(50).sql, bootstrapSchema: false },
		)
		const expected = {
			spans: "6",
			EstimatedUnder50Ms: "1",
			EstimatedUnder100Ms: "3",
			EstimatedUnder250Ms: "3",
			EstimatedUnder500Ms: "4",
			EstimatedUnder1000Ms: "8",
			EstimatedUnder2500Ms: "9",
			EstimatedUnder5000Ms: "9",
			EstimatedUnder10000Ms: "9",
		}
		expect(fresh.hourly).toEqual(expected)
		expect(fresh.minutely).toEqual(expected)
	})
})
