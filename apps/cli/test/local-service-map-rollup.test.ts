import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import * as CH from "@maple/query-engine/ch"
import { Effect, Schema } from "effect"
import schemaSql from "../src/server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "../src/server/chdb"
import { decodeJsonEachRow } from "../src/server/chdb-rows"
import {
	type LocalServiceMapRollupDeps,
	type LocalServiceMapRollupState,
	ROLLUP_SETTLE_MS,
	runLocalServiceMapRollupTick,
} from "../src/server/service-map-rollup"

// Needs a real libchdb; skipped where none is installed.
const libchdbAvailable =
	(process.env.MAPLE_LIBCHDB !== undefined && existsSync(process.env.MAPLE_LIBCHDB)) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.so")) ||
	existsSync(join(homedir(), ".maple", "bin", "libchdb.dylib"))

const HOUR_MS = 3_600_000
const iso = (ms: number) => new Date(ms).toISOString().replace("T", " ").replace("Z", "")

/** One `frontend` Client span calling a child `api` Server span at `atMs`. */
const callRows = (atMs: number, n: number): string => {
	const traceId = `trace-${atMs}-${n}`
	const client = `('local', '${iso(atMs)}', '${traceId}', 'c${n}', '', 'GET /api', 'Client', 'frontend', 5000000, 'Ok', map('server.address', 'api.internal'))`
	const server = `('local', '${iso(atMs + 1)}', '${traceId}', 's${n}', 'c${n}', 'GET /api', 'Server', 'api', 4000000, 'Ok', map())`
	return `${client}, ${server}`
}

const decodeCount = decodeJsonEachRow(Schema.Struct({ n: Schema.String }))
const count = (db: Chdb, sql: string): number => Number(decodeCount(db.query(sql))[0]?.n)
const decodeEdges = decodeJsonEachRow(
	Schema.Struct({ sourceService: Schema.String, targetService: Schema.String, callCount: CH.CHNumber }),
)

describe.skipIf(!libchdbAvailable)("local service map rollup", () => {
	let root = ""
	let db: Chdb
	const nowMs = Date.now()
	const currentHourMs = Math.floor(nowMs / HOUR_MS) * HOUR_MS
	// Ticks run one settle lag later, so they see the same current hour as the seed.
	const tickAt = nowMs + ROLLUP_SETTLE_MS
	const twoHoursBack = currentHourMs - 2 * HOUR_MS + 10 * 60_000
	const oneHourBack = currentHourMs - HOUR_MS + 5 * 60_000

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-smap-rollup-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		const rows = [callRows(twoHoursBack, 1), callRows(twoHoursBack, 2), callRows(oneHourBack, 3)]
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SpanAttributes) VALUES ${rows.join(", ")}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root) rmSync(root, { recursive: true, force: true })
	})

	const deps = (): LocalServiceMapRollupDeps => ({
		db,
		gate: { enter: () => () => undefined },
		isRetiredDay: () => false,
	})
	const edgeCalls = () =>
		count(db, "SELECT toString(sum(CallCount)) AS n FROM service_map_edges_hourly WHERE OrgId = 'local'")

	test("seals completed hours and the full-window dependencies read sees every call", async () => {
		const state: LocalServiceMapRollupState = { catchUp: undefined }
		const tick = await Effect.runPromise(runLocalServiceMapRollupTick(deps(), state, tickAt))
		expect(tick.admitted).toBe(true)
		expect(edgeCalls()).toBe(3)
		expect(
			count(
				db,
				"SELECT toString(uniqExact(Hour)) AS n FROM service_map_edges_hourly WHERE OrgId = 'local' AND SourceService = 'frontend' AND TargetService = 'api'",
			),
		).toBe(2)
		expect(
			count(
				db,
				"SELECT toString(count()) AS n FROM service_address_resolutions_hourly WHERE OrgId = 'local' AND ParentServerAddress = 'api.internal' AND ResolvedTargetService = 'api'",
			),
		).toBeGreaterThan(0)

		const compiled = await Effect.runPromise(
			CH.serviceDependenciesSQL(
				{},
				{
					orgId: "local",
					startTime: iso(currentHourMs - 3 * HOUR_MS).slice(0, 19),
					endTime: iso(nowMs).slice(0, 19),
				},
			),
		)
		const rows = decodeEdges(
			db.query(compiled.sql.replace(/\s+FORMAT\s+\w+\s*$/, "\nFORMAT JSONEachRow")),
		)
		const edge = rows.find((row) => row.sourceService === "frontend" && row.targetService === "api")
		expect(Number(edge?.callCount)).toBe(3)
	})

	test("a second tick is a no-op for sealed hours", async () => {
		const state: LocalServiceMapRollupState = { catchUp: undefined }
		await Effect.runPromise(runLocalServiceMapRollupTick(deps(), state, tickAt))
		expect(edgeCalls()).toBe(3)
	})

	test("a closed gate writes nothing and reports the tick as not admitted", async () => {
		const state: LocalServiceMapRollupState = { catchUp: undefined }
		const tick = await Effect.runPromise(
			runLocalServiceMapRollupTick(
				{ ...deps(), gate: { enter: () => null } },
				state,
				tickAt + 2 * HOUR_MS,
			),
		)
		expect(tick.admitted).toBe(false)
		expect(tick.hoursRolledUp).toBe(0)
		expect(edgeCalls()).toBe(3)
	})
})
