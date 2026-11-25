import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Schema, String as Str } from "effect"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import type { MigrationModuleContext } from "@maple/local-server/local-store-migration-module"
import { localSchemaSnapshot } from "@maple/local-server/local-schema-history"
import { describeWithChdb } from "./libchdb-test-support"
import { migrationStep, openStore } from "./local-store-step-test-support"

const iso = (ms: number) => Str.replace("Z", "")(Str.replace("T", " ")(new Date(ms).toISOString()))

const decodeDays = decodeJsonEachRow(Schema.Struct({ name: Schema.String, days: Schema.String }))

const decodeNames = decodeJsonEachRow(Schema.Struct({ name: Schema.String }))

/** Each row's stored period, by a column that names the row. */
const retentionDays = (db: Chdb, table: string, nameColumn: string) =>
	decodeDays(
		db.query(
			`SELECT ${nameColumn} AS name, toString(RetentionDays) AS days FROM ${table} WHERE OrgId = 'local' ORDER BY name`,
		),
	)

const pageView = (atMs: number, session: string) =>
	`INSERT INTO session_events (OrgId, SessionId, Timestamp, Seq, Type, Url) VALUES ('local', '${session}', '${iso(atMs)}', 1, 'navigation', 'https://app.example.com/${session}')`

const annotatedSpan = (atMs: number, name: string) =>
	`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, SpanKind, ServiceName, SpanAttributes) VALUES ('local', '${iso(atMs)}', '${name}-trace', '${name}-span', 'Server', 'api', map('maple.product_event.name', '${name}'))`

describeWithChdb("v66 -> v67 RetentionDays on the raw tables", () => {
	const STEP_ID = "local-0066-to-0067-retention-days"
	let migration: ReturnType<typeof migrationStep>["migration"]
	let root = ""
	let sourceDataDir = ""
	let targetDataDir = ""
	let context: MigrationModuleContext
	const nowMs = Date.now()
	const earlierMs = nowMs - 3_600_000

	beforeAll(async () => {
		root = await mkdtemp(join(tmpdir(), "maple-retention-days-"))
		sourceDataDir = join(root, "source", "data")
		targetDataDir = join(root, "target", "data")
		const db = Chdb.open({ dataDir: sourceDataDir, schemaSql: localSchemaSnapshot(66).sql })
		db.exec(pageView(earlierMs, "before"))
		db.exec(annotatedSpan(earlierMs, "before_span"))
		db.exec(
			`INSERT INTO product_events (OrgId, Timestamp, Source, Kind, EventName) VALUES ('local', '${iso(earlierMs)}', 'server', 'custom', 'before_server')`,
		)
		db.exec(
			`INSERT INTO metrics_sum (OrgId, ServiceName, MetricName, TimeUnix, Value) VALUES ('local', 'api', 'before_metric', '${iso(earlierMs)}', 1)`,
		)
		db.exec(
			`INSERT INTO profiles (OrgId, Timestamp, ServiceName, SampleType, SampleUnit, Value) VALUES ('local', '${iso(earlierMs)}', 'before_profile', 'cpu', 'nanoseconds', 1)`,
		)
		db.close()
		;({ migration, context } = migrationStep(STEP_ID, sourceDataDir, targetDataDir, nowMs))
	})

	afterAll(async () => {
		if (root) await rm(root, { recursive: true, force: true })
	})

	test("every existing row reads the period its table keeps today", async () => {
		const state = await migration.preflight(context)
		await migration.prepareTarget(context, state)
		const progress = await migration.apply(context, state, undefined)
		await migration.verify(context, state, progress)

		const stored = await openStore(
			targetDataDir,
			(db) => ({
				traces: retentionDays(db, "traces", "SpanName"),
				sessionEvents: retentionDays(db, "session_events", "SessionId"),
				metrics: retentionDays(db, "metrics_sum", "MetricName"),
				profiles: retentionDays(db, "profiles", "ServiceName"),
			}),
			{ schemaSql: localSchemaSnapshot(67).sql, bootstrapSchema: false },
		)
		expect(stored.traces).toEqual([{ name: "", days: "30" }])
		expect(stored.sessionEvents).toEqual([{ name: "before", days: "30" }])
		expect(stored.metrics).toEqual([{ name: "before_metric", days: "90" }])
		expect(stored.profiles).toEqual([{ name: "before_profile", days: "14" }])
	})

	test("a stamped row keeps its own period, and the views still fill product_events", async () => {
		const stored = await openStore(
			targetDataDir,
			(db) => {
				db.exec(pageView(nowMs, "after"))
				db.exec(annotatedSpan(nowMs, "after_span"))
				db.exec(
					`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, SpanName, SpanKind, ServiceName, RetentionDays) VALUES ('local', '${iso(nowMs)}', 'stamped-trace', 'stamped-span', 'stamped', 'Server', 'api', 7)`,
				)
				return {
					traces: retentionDays(db, "traces", "SpanName"),
					productEvents: decodeNames(
						db.query(
							"SELECT concat(Source, ':', SessionId, TraceId) AS name FROM product_events WHERE OrgId = 'local' ORDER BY name",
						),
					),
				}
			},
			{ schemaSql: localSchemaSnapshot(67).sql, bootstrapSchema: false },
		)
		expect(stored.traces).toEqual([
			{ name: "", days: "30" },
			{ name: "", days: "30" },
			{ name: "stamped", days: "7" },
		])
		expect(stored.productEvents).toEqual([
			{ name: "browser:after" },
			{ name: "browser:before" },
			{ name: "server:" },
			{ name: "trace:after_span-trace" },
			{ name: "trace:before_span-trace" },
		])
	})
})
