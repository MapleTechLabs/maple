// SAFETY-FILE: JSON in this test is emitted by the fixture or unit under test before its fields are asserted.
// Synthetic exporter shapes exercise the real warehouse projection and migration.
// They are not captured Cloudflare payloads; exporter compatibility needs its own fixture.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import { migrations } from "@maple/domain/clickhouse"
import { Schema } from "effect"
import { msToDate } from "../../platform/time"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_error_events_attrs_e2e")
const ORG_ID = "org_error_events_attrs"
const SERVICE = "cf-worker"

/**
 * Now-relative, not a fixed date: `traces` and both error tables enforce a TTL
 * at insert time, and a hardcoded timestamp silently drops every seed once it
 * ages past the horizon, leaving the suite comparing nothing to nothing.
 */
const SEED_MS = Date.now() - 60 * 60 * 1000
const chDateTime = (epochMs: number): string => msToDate(epochMs).toISOString().replace("T", " ").slice(0, 19)
const SEED_TS = chDateTime(SEED_MS)

const quote = (value: string): string => `'${value.replace(/\\/g, "\\\\").replace(/'/g, "\\'")}'`
const chMap = (entries: Readonly<Record<string, string>>): string => {
	const pairs = Object.entries(entries).flatMap(([key, value]) => [quote(key), quote(value)])
	return pairs.length === 0 ? "map()" : `map(${pairs.join(", ")})`
}

interface ExceptionEvent {
	readonly type: string
	readonly message: string
	readonly stacktrace: string
}

interface SeedSpan {
	readonly spanId: string
	readonly kind: "Client" | "Server"
	readonly statusMessage: string
	readonly spanAttributes: Readonly<Record<string, string>>
	readonly exceptionEvent?: ExceptionEvent
}

const SEED_SPANS: ReadonlyArray<SeedSpan> = [
	// The case this file exists for: no event, no status description, only
	// semconv error.* attributes.
	{
		spanId: "cf-error-type",
		kind: "Server",
		statusMessage: "",
		spanAttributes: {
			"error.type": "TypeError",
			"error.message": "Cannot load account 1234567890",
			"http.request.method": "GET",
		},
	},
	// Same type, different message: must be a different issue, not one
	// "TypeError" bucket per service.
	{
		spanId: "cf-error-type-other-bug",
		kind: "Server",
		statusMessage: "",
		spanAttributes: {
			"error.type": "TypeError",
			"error.message": "Cannot read properties of null (reading 'headers')",
		},
	},
	// Same bug, different id in the message: the redacted signature groups them.
	{
		spanId: "cf-error-type-same-bug",
		kind: "Server",
		statusMessage: "",
		spanAttributes: {
			"error.type": "TypeError",
			"error.message": "Cannot load account 9876543210",
			"user.id": "u_1234567890",
		},
	},
	// exception.* attributes win over error.*, and the stacktrace attribute
	// feeds the frame portion of the hash.
	{
		spanId: "cf-exception-attrs",
		kind: "Server",
		statusMessage: "",
		spanAttributes: {
			"exception.type": "RangeError",
			"exception.message": "offset 4096 is out of range",
			"exception.stacktrace":
				"RangeError: offset 4096 is out of range\n    at slice (worker.js:1542:13655)",
			"error.type": "LosesToException",
			"error.message": "must not be read",
		},
	},
	// A real exception event keeps exactly the precedence it always had, even
	// when attributes disagree with it.
	{
		spanId: "event-wins",
		kind: "Server",
		statusMessage: "status text",
		spanAttributes: {
			"exception.type": "AttrError",
			"error.type": "AttrError2",
			"error.message": "attr",
		},
		exceptionEvent: {
			type: "EventError",
			message: "from the event",
			stacktrace: "    at handler (/app/src/routes/user.ts:17:21)",
		},
	},
	// The StatusMessage fallback is unchanged for spans with nothing else.
	{
		spanId: "status-only",
		kind: "Server",
		statusMessage: "DatabaseError: connection reset",
		spanAttributes: {},
	},
	// StatusMessage still supplies the message text when it is set, so an
	// event-less span that already had one keeps its hash.
	{
		spanId: "status-and-error-type",
		kind: "Server",
		statusMessage: "connection reset",
		spanAttributes: { "error.type": "TimeoutError", "error.message": "attribute message" },
	},
	{
		spanId: "status-and-exception-attrs",
		kind: "Server",
		statusMessage: "connection reset",
		spanAttributes: {
			"exception.type": "TimeoutError",
			"exception.message": "attribute message",
			"exception.stacktrace": "TimeoutError: reset\n    at connect (/app/db.ts:12:4)",
		},
	},
	{
		spanId: "empty-event",
		kind: "Server",
		statusMessage: "",
		spanAttributes: { "exception.type": "IgnoredError", "error.message": "ignored" },
		exceptionEvent: { type: "", message: "", stacktrace: "" },
	},
	// Nothing carries an exception: still the Unknown Error bucket.
	{
		spanId: "unknown",
		kind: "Server",
		statusMessage: "",
		spanAttributes: { "http.request.method": "GET" },
	},
	// The 0016 guard: a 4xx client span whose only error.type is the status code
	// (HTTP semconv sets that on any non-2xx response) is bot noise, not an error.
	{
		spanId: "bot-404",
		kind: "Client",
		statusMessage: "",
		spanAttributes: { "http.response.status_code": "404", "error.type": "404", "url.path": "/wp-admin" },
	},
	// ...but a 4xx carrying a real exception type is still an error.
	{
		spanId: "real-4xx",
		kind: "Client",
		statusMessage: "",
		spanAttributes: { "http.response.status_code": "400", "error.type": "ValidationError" },
	},
]

const seed = async (): Promise<void> => {
	const rows = SEED_SPANS.map((row) => {
		const resource = chMap({
			"service.version": "e2e",
			"deployment.environment.name": "production",
		})
		const events =
			row.exceptionEvent === undefined
				? "[], [], []"
				: `[toDateTime64(${quote(SEED_TS)}, 9)], ['exception'], [${chMap({
						"exception.type": row.exceptionEvent.type,
						"exception.message": row.exceptionEvent.message,
						"exception.stacktrace": row.exceptionEvent.stacktrace,
					})}]`
		return `(${quote(ORG_ID)}, ${quote(SEED_TS)}, ${quote(`trace-${row.spanId}`)}, ${quote(row.spanId)}, '', 'GET /', ${quote(row.kind)}, ${quote(SERVICE)}, 1000000, 'Error', ${quote(row.statusMessage)}, ${chMap(row.spanAttributes)}, ${resource}, ${events})`
	}).join(",\n")

	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SpanAttributes, ResourceAttributes, EventsTimestamp, EventsName, EventsAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const ErrorEventRow = Schema.Struct({
	SpanId: Schema.String,
	ErrorLabel: Schema.String,
	ExceptionType: Schema.String,
	ExceptionMessage: Schema.String,
	ExceptionStacktrace: Schema.String,
	TopFrame: Schema.String,
	FingerprintHash: Schema.String,
})
type ErrorEventRow = typeof ErrorEventRow.Type
const decodeErrorEvent = Schema.decodeUnknownSync(Schema.fromJsonString(ErrorEventRow))

const readErrorEvents = async (from: string): Promise<Map<string, ErrorEventRow>> => {
	const body = await clickhouseExec(
		`SELECT SpanId, ErrorLabel, ExceptionType, ExceptionMessage, ExceptionStacktrace, TopFrame, toString(FingerprintHash) AS FingerprintHash
		 FROM ${from}
		 WHERE OrgId = ${quote(ORG_ID)}
		 ORDER BY SpanId
		 FORMAT JSONEachRow`,
		database,
	)
	const rows = body
		.split("\n")
		.filter((line) => line.trim().length > 0)
		.map(decodeErrorEvent)
	const bySpan = new Map(rows.map((row) => [row.SpanId, row]))
	assert.strictEqual(bySpan.size, rows.length, "unexpected duplicate occurrences")
	return bySpan
}

const mustGet = (rows: Map<string, ErrorEventRow>, spanId: string): ErrorEventRow => {
	const row = rows.get(spanId)
	assert.isDefined(row, `expected ${spanId} to be materialized into error_events`)
	return row
}

describe.skipIf(!clickhouseE2eEnabled)("error_events attribute fallback (ClickHouse e2e)", () => {
	let rows: Map<string, ErrorEventRow>

	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE IF NOT EXISTS ${database}`)
		await applyRealMigrations(database)
		await seed()
		rows = await readErrorEvents("error_events")
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	})

	it("labels an attribute-only span from its error.* attributes", () => {
		const row = mustGet(rows, "cf-error-type")
		assert.strictEqual(row.ErrorLabel, "TypeError")
		assert.strictEqual(row.ExceptionType, "TypeError")
		assert.strictEqual(row.ExceptionMessage, "Cannot load account 1234567890")
		assert.strictEqual(row.ExceptionStacktrace, "")
		assert.notStrictEqual(row.FingerprintHash, mustGet(rows, "unknown").FingerprintHash)
	})

	it("separates two bugs of the same type in one Worker, and groups one bug across ids", () => {
		const bug = mustGet(rows, "cf-error-type")
		assert.notStrictEqual(bug.FingerprintHash, mustGet(rows, "cf-error-type-other-bug").FingerprintHash)
		assert.strictEqual(bug.FingerprintHash, mustGet(rows, "cf-error-type-same-bug").FingerprintHash)
	})

	it("reads exception.* attributes ahead of error.*, stacktrace included", () => {
		const row = mustGet(rows, "cf-exception-attrs")
		assert.strictEqual(row.ErrorLabel, "RangeError")
		assert.strictEqual(row.ExceptionMessage, "offset 4096 is out of range")
		assert.include(row.ExceptionStacktrace, "at slice")
		assert.strictEqual(row.TopFrame, "    at slice (worker.js)")
	})

	it("keeps the exception event's precedence when a span has one", () => {
		const row = mustGet(rows, "event-wins")
		assert.strictEqual(row.ErrorLabel, "EventError")
		assert.strictEqual(row.ExceptionMessage, "from the event")
		assert.strictEqual(row.TopFrame, "    at handler (/app/src/routes/user.ts)")
	})

	it("keeps the StatusMessage and Unknown Error fallbacks for everything else", () => {
		assert.strictEqual(mustGet(rows, "status-only").ErrorLabel, "DatabaseError")
		assert.strictEqual(mustGet(rows, "status-only").ExceptionMessage, "DatabaseError: connection reset")
		assert.strictEqual(mustGet(rows, "unknown").ErrorLabel, "Unknown Error")
	})

	it("preserves pre-migration hashes and details for events and status messages", async () => {
		// Migration 0020 is the last deployed definition of these views before 0030.
		// Evaluate its frozen SELECT against identical spans; do not reimplement hashing.
		const previousView = migrations
			.find((migration) => migration.version === 20)
			?.statements.find(
				(statement) =>
					typeof statement === "string" &&
					statement.startsWith("CREATE MATERIALIZED VIEW IF NOT EXISTS error_events_mv "),
			)
		assert.isString(previousView)
		const previousSelect = previousView.slice(previousView.indexOf(" AS\n") + 4)
		const previousRows = await readErrorEvents(`(${previousSelect})`)
		for (const spanId of [
			"event-wins",
			"empty-event",
			"status-only",
			"status-and-error-type",
			"status-and-exception-attrs",
			"unknown",
		]) {
			assert.deepStrictEqual(mustGet(rows, spanId), mustGet(previousRows, spanId), spanId)
		}
	})

	it("preserves stored occurrences when the migration is reapplied", async () => {
		const migration = migrations.find((entry) => entry.version === 30)
		assert.isDefined(migration)
		for (const statement of migration.statements) {
			assert.isString(statement)
			await clickhouseExec(statement, database)
		}
		assert.deepStrictEqual(await readErrorEvents("error_events"), rows)
		assert.deepStrictEqual(await readErrorEvents("error_events_by_time"), rows)
	})

	it("still drops a 4xx client span whose only error.type is the status code", () => {
		assert.isUndefined(rows.get("bot-404"))
		assert.strictEqual(mustGet(rows, "real-4xx").ErrorLabel, "ValidationError")
	})

	it("writes the same projection to error_events_by_time", async () => {
		const byTime = await readErrorEvents("error_events_by_time")
		assert.deepStrictEqual([...byTime.keys()], [...rows.keys()])
		for (const [spanId, row] of rows) {
			assert.deepStrictEqual(byTime.get(spanId), row, `error_events_by_time disagrees on ${spanId}`)
		}
	})
})
