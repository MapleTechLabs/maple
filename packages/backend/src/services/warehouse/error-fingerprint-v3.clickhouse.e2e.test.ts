// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Fingerprint v3 parity: the hash the error_events MV computes must be
// cityHash64 of exactly the inputs the TS mirror derives, for every v3 rule.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { computeFingerprintInputs, FINGERPRINT_HASH_SALT } from "@maple/domain/tinybird/fingerprint"
import { Schema } from "effect"
import { msToDate } from "../../platform/time"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_error_fingerprint_v3_e2e")
const ORG_ID = "org_error_fingerprint_v3"
const SERVICE = "api"

/** Now-relative: the tables enforce a TTL at insert time. */
const SEED_TS = msToDate(Date.now() - 60 * 60 * 1000)
	.toISOString()
	.replace("T", " ")
	.slice(0, 19)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`

interface Seed {
	readonly spanId: string
	readonly type: string
	readonly message: string
	readonly stacktrace: string
}

const frames = (...lines: ReadonlyArray<string>) => ["Error: boom", ...lines].join("\n")

const SEEDS: ReadonlyArray<Seed> = [
	{
		spanId: "namespaced",
		type: "@maple/http/errors/UpstreamUnavailable",
		message: "upstream 503",
		stacktrace: frames(
			"    at toUpstreamError (/app/src/upstream.ts:40:11)",
			"    at listTraces (/app/src/traces.ts:12:3)",
		),
	},
	{
		spanId: "generic-caller-a",
		type: "TypeError",
		message: "Cannot read properties of undefined (reading 'id')",
		stacktrace: frames("    at Array.map (<anonymous>)", "    at renderRows (/app/src/table.ts:10:2)"),
	},
	{
		spanId: "effect-span-frames",
		type: "DatabaseError",
		message: "connection reset",
		stacktrace: frames(
			"    at query (/app/src/db.ts:5:1)",
			"    at db.query (definition) (/app/src/db.ts:3:20)",
			"    at load (/app/src/load.ts:7:2)",
		),
	},
	{
		spanId: "store-version",
		type: "Error",
		message: "failed",
		stacktrace: frames(
			"    at fail (/app/node_modules/.bun/effect@4.0.4-beta.1/node_modules/effect/dist/Effect.js:1:1)",
			"    at Promise.all (index 17)",
		),
	},
	{
		spanId: "ch-echo",
		type: "",
		message: "Code: 62. DB::Exception: Syntax error: failed at position 12 (SELECT foo\nFROM bar)",
		stacktrace: "",
	},
	{
		spanId: "ch-envelope",
		type: "",
		message: "[Error] Unknown identifier `TraceIdd` in scope SELECT TraceIdd FROM traces",
		stacktrace: "",
	},
	{
		spanId: "fs-path",
		type: "",
		message: "ENOENT: no such file or directory, open '/tmp/maple-a81f/wal.log' (=/var/run/x.sock)",
		stacktrace: "",
	},
	{
		spanId: "route-path",
		type: "",
		message: "Transport error (POST /api/data/export) for /Users/riordan/.maple/store",
		stacktrace: "",
	},
	{
		spanId: "ids",
		type: "",
		message: "no customer for org_2NnAbCdEfGhIjKlM, run 01HZY3K4W7Q9N2B6C8D0E5F1GA, cus_QwErTyUiOpAsDf",
		stacktrace: "",
	},
	{
		spanId: "quoted-table",
		type: "",
		message: "Table 'checkout_events' doesn't exist",
		stacktrace: "",
	},
	{
		spanId: "json-uuid",
		type: "",
		message: JSON.stringify({ error: "not_found", id: "550e8400-e29b-41d4-a716-446655440000", n: 42 }),
		stacktrace: "",
	},
	// v3.1
	{
		spanId: "namespaced-empty-message",
		type: "@maple/discord/RateLimited",
		message: "",
		stacktrace: frames("    at fail (/app/src/fail.ts:4:1)", "    at send (/app/src/send.ts:9:2)"),
	},
	{
		spanId: "bundle-frames",
		type: "Error",
		message: "failed",
		stacktrace: frames(
			'  at [2]["params"]',
			"    at a (file:///bundle/worker.js:1:2)",
			"    at b (https://x.dev/assets/index-AbCd1234-EfGh5678.js:1:2)",
			"    at c (https://x.dev/_astro/Layout.AbCd1234.js:1:2)",
		),
	},
	{
		spanId: "ansi",
		type: "",
		message: "\x1b[31mconnection refused\x1b[0m",
		stacktrace: "",
	},
	{
		spanId: "ch-while-processing",
		type: "",
		message:
			"DB::Exception: Illegal type String of argument of function plus: While processing plus(a, 1)",
		stacktrace: "",
	},
	{
		spanId: "path-variants",
		type: "",
		message:
			"copy /data.quarantine-x1/store /var/b, ~/.maple/x, read /datasets/x, retry in ~5 min, key top_operations",
		stacktrace: "",
	},
	// Location-less span frames: `at http.client POST` became `at POST` in effect 4.0.4.
	...["    at http.client POST", "    at POST"].map((spanFrame, index) => ({
		spanId: `span-name-frame-${index}`,
		type: "HttpClientError",
		message: "Transport error (POST /api/query)",
		stacktrace: frames(
			"    at catch (https://x.dev/assets/client.js:1:2)",
			spanFrame,
			"    at load (/app/src/load.ts:7:2)",
		),
	})),
	{
		spanId: "paren-less-location",
		type: "Error",
		message: "failed",
		stacktrace: frames("    at file:///app/a.js:1:2"),
	},
	...[401, 404, 500, 502, 520, 524].map((status) => ({
		spanId: `http-${status}`,
		type: "",
		message: `upstream returned ${status}, HTTP ${status} after 3 tries`,
		stacktrace: "",
	})),
]

const seed = async (): Promise<void> => {
	const rows = SEEDS.map(
		(row) =>
			`(${quote(ORG_ID)}, ${quote(SEED_TS)}, ${quote(`trace-${row.spanId}`)}, ${quote(row.spanId)}, '', 'GET /', 'Server', ${quote(SERVICE)}, 1000000, 'Error', ${quote(row.message)}, map(), map(), [toDateTime64(${quote(SEED_TS)}, 9)], ['exception'], [map('exception.type', ${quote(row.type)}, 'exception.message', ${quote(row.message)}, 'exception.stacktrace', ${quote(row.stacktrace)})])`,
	).join(",\n")
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, EventsTimestamp, EventsName, EventsAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const HashRow = Schema.Struct({ SpanId: Schema.String, TopFrame: Schema.String, Hash: Schema.String })
type HashRow = typeof HashRow.Type
const decodeHashRow = Schema.decodeUnknownSync(Schema.fromJsonString(HashRow))

const readRows = async (sql: string): Promise<Map<string, HashRow>> => {
	const body = await clickhouseExec(`${sql} FORMAT JSONEachRow`, database)
	const rows = body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map(decodeHashRow)
	return new Map(rows.map((row) => [row.SpanId, row]))
}

/** cityHash64 over the TS mirror's inputs, evaluated by ClickHouse itself. */
const mirroredSql = SEEDS.map((row) => {
	const inputs = computeFingerprintInputs({
		exceptionType: row.type,
		exceptionStacktrace: row.stacktrace,
		statusMessage: row.message,
	})
	return `SELECT ${quote(row.spanId)} AS SpanId, ${quote(inputs.topFrame)} AS TopFrame, toString(cityHash64(${quote(ORG_ID)}, ${quote(SERVICE)}, ${quote(row.type)}, ${quote(inputs.fpFrames)}, ${quote(inputs.msgSignature)}, ${quote(FINGERPRINT_HASH_SALT)})) AS Hash`
}).join("\nUNION ALL\n")

describe.skipIf(!clickhouseE2eEnabled)("error fingerprint v3 (ClickHouse e2e)", () => {
	let materialized: Map<string, HashRow>
	let mirrored: Map<string, HashRow>

	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE IF NOT EXISTS ${database}`)
		await applyRealMigrations(database)
		await seed()
		materialized = await readRows(
			`SELECT SpanId, TopFrame, toString(FingerprintHash) AS Hash FROM error_events WHERE OrgId = ${quote(ORG_ID)}`,
		)
		mirrored = await readRows(mirroredSql)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	for (const { spanId } of SEEDS) {
		it(`hashes ${spanId} exactly as the TS mirror does`, () => {
			const actual = materialized.get(spanId)
			assert.isDefined(actual, `${spanId} was not materialized`)
			assert.deepStrictEqual(actual, mirrored.get(spanId))
		})
	}
})
