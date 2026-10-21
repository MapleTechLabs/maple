import { assert, describe, it } from "@effect/vitest"
import { Schema } from "effect"
// A live logs response (2026-10-21) with the project ref, client IPs, geo, ISP and JWT signature
// fields replaced by placeholders (documentation IPs, "Example City", AS64500).
import sample from "./__fixtures__/supabase-logs-sample.json" with { type: "json" }
import {
	advanceWatermark,
	decodeLogRows,
	LOGS_PAGE_SIZE,
	logsQueryUrl,
	logsToOtlp,
	nextLogsWindow,
	parseRowTimestamp,
} from "./logs"
import { SupabaseProjectRef } from "@maple/domain/primitives"

const REF = Schema.decodeUnknownSync(SupabaseProjectRef)("abcdefghijklmnopqrst")
const minute = 60_000
const now = Date.UTC(2026, 9, 21, 18, 0, 30, 500)

const resource = {
	projectRef: REF,
	projectName: "app",
	region: "eu-central-1",
	organizationSlug: "acme",
	sourceId: "src_test",
}

const otlp = (raw: ReadonlyArray<unknown>) => logsToOtlp(resource, decodeLogRows(raw))

const attributeMap = (attributes: ReadonlyArray<{ key: string; value: { stringValue: string } }>) =>
	Object.fromEntries(attributes.map((attribute) => [attribute.key, attribute.value.stringValue]))

describe("nextLogsWindow", () => {
	it("starts five minutes back on a fresh project and stays a minute behind now, on a second", () => {
		const end = Date.UTC(2026, 9, 21, 17, 59, 30)
		assert.deepStrictEqual(nextLogsWindow(null, now), { startMs: end - 5 * minute, endMs: end })
	})

	it("catches a long gap up one hour at a time from the watermark", () => {
		const watermark = now - 6 * 60 * minute
		assert.deepStrictEqual(nextLogsWindow(watermark, now), {
			startMs: watermark,
			endMs: watermark + 60 * minute,
		})
	})

	it("returns null once the watermark reaches the horizon", () => {
		assert.isNull(nextLogsWindow(Date.UTC(2026, 9, 21, 17, 59, 30), now))
	})
})

describe("logsQueryUrl", () => {
	it("bounds the SQL exactly and widens the minute-rounded range outward", () => {
		const window = {
			startMs: Date.UTC(2026, 9, 21, 17, 55, 0, 123),
			endMs: Date.UTC(2026, 9, 21, 17, 59, 30),
		}
		const url = new URL(logsQueryUrl("https://api.supabase.com", REF, window))
		assert.strictEqual(url.pathname, "/v1/projects/abcdefghijklmnopqrst/analytics/endpoints/logs")
		assert.strictEqual(
			url.searchParams.get("sql"),
			"select id, timestamp, source, event_message, log_attributes from logs where timestamp >= '2026-10-21 17:55:00.123000' and timestamp < '2026-10-21 17:59:30.000000' order by timestamp asc, id asc limit 1000",
		)
		assert.strictEqual(url.searchParams.get("iso_timestamp_start"), "2026-10-21T17:55:00.000Z")
		assert.strictEqual(url.searchParams.get("iso_timestamp_end"), "2026-10-21T18:00:00.000Z")
	})
})

describe("parseRowTimestamp", () => {
	it("reads the column as UTC and keeps its microseconds in the nanosecond string", () => {
		assert.deepStrictEqual(parseRowTimestamp("2026-10-21T17:48:12.059679"), {
			ms: Date.UTC(2026, 9, 21, 17, 48, 12, 59),
			unixNano: `${Date.UTC(2026, 9, 21, 17, 48, 12) / 1000}059679000`,
		})
	})

	it("rejects a value that is not a timestamp", () => {
		assert.isUndefined(parseRowTimestamp("yesterday"))
		assert.isUndefined(parseRowTimestamp("2026-10-21T17:48:12+02:00"))
	})
})

describe("logsToOtlp", () => {
	const payload = otlp(sample.result)
	const records = payload.resourceLogs[0]!.scopeLogs[0]!.logRecords
	const byId = new Map(records.map((record) => [attributeMap(record.attributes)["log.record.uid"], record]))
	const severityOfRow = (id: string) => {
		const record = byId.get(id)
		return record === undefined ? undefined : [record.severityText, record.severityNumber]
	}

	it("maps every fixture row, one record per row", () => {
		assert.strictEqual(records.length, sample.result.length)
		assert.deepStrictEqual(
			[
				...new Set(records.map((record) => attributeMap(record.attributes)["supabase.log.source"])),
			].toSorted(),
			[
				"auth_logs",
				"edge_logs",
				"pgbouncer_logs",
				"postgres_logs",
				"postgrest_logs",
				"realtime_logs",
				"storage_logs",
			],
		)
	})

	it("derives severity from each source's own hint", () => {
		const severities = sample.result.map((row) => [
			row.source,
			severityOfRow(row.id)?.[0],
			row.event_message.slice(0, 30),
		])
		const expectSeverity = (source: string, startsWith: string, severity: string) => {
			const match = severities.find(
				(item) => item[0] === source && String(item[2]).startsWith(startsWith),
			)
			assert.strictEqual(match?.[1], severity, `${source} "${startsWith}"`)
		}
		// postgres: parsed.error_severity (LOG -> INFO, ERROR -> ERROR)
		expectSeverity("postgres_logs", "checkpoint complete", "INFO")
		expectSeverity("postgres_logs", 'relation "pg_stat_statements"', "ERROR")
		// realtime/storage/auth: `level`
		expectSeverity("realtime_logs", "Database supervisor not found", "WARN")
		expectSeverity("realtime_logs", "PUT /api/tenants", "INFO")
		expectSeverity("storage_logs", "abcdefghijklmnopqrst | PUT", "INFO")
		expectSeverity("auth_logs", '{"level":"info"', "INFO")
		// edge: the response status (4xx -> WARN, 2xx -> INFO)
		expectSeverity("edge_logs", "GET | 401", "WARN")
		expectSeverity("edge_logs", "POST | 200", "INFO")
		// No hint at all reads as INFO.
		expectSeverity("pgbouncer_logs", "C-0xc8e0dccfeb58", "INFO")
		expectSeverity("postgrest_logs", "Schema cache loaded in", "INFO")
		assert.deepStrictEqual(severityOfRow("45a6d4e9-f44d-4052-8926-b9a8f0fbc199"), ["INFO", 9])
	})

	it("maps a 5xx edge response to ERROR", () => {
		const record = otlp([
			{
				id: "x",
				timestamp: "2026-10-21T17:00:00.000000",
				source: "edge_logs",
				event_message: "GET | 502 | /rest/v1/",
				log_attributes: { "response.status_code": "502" },
			},
		]).resourceLogs[0]!.scopeLogs[0]!.logRecords[0]!
		assert.strictEqual(record.severityText, "ERROR")
		assert.strictEqual(record.severityNumber, 17)
	})

	it("keeps the time to the microsecond, the message as body and every attribute as a string", () => {
		const record = byId.get("45a6d4e9-f44d-4052-8926-b9a8f0fbc199")!
		assert.strictEqual(record.timeUnixNano, `${Date.UTC(2026, 9, 21, 17, 48, 12) / 1000}059679000`)
		assert.strictEqual(
			record.body.stringValue,
			"C-0xc8e0dccfeb58: postgres/pgbouncer@[::1]:50667 closing because: client close request (age=0s)",
		)
		assert.deepStrictEqual(attributeMap(record.attributes), {
			_RUNTIME_SCOPE: "system",
			__SEQNUM: "9707",
			__SEQNUM_ID: "e0851259339f4ed69e648e8b96b69f0a",
			host: "db-abcdefghijklmnopqrst",
			project: "abcdefghijklmnopqrst",
			"supabase.log.source": "pgbouncer_logs",
			"log.record.uid": "45a6d4e9-f44d-4052-8926-b9a8f0fbc199",
		})
	})

	it("keeps an auth log's JSON message as the body", () => {
		const row = sample.result.find((item) => item.source === "auth_logs")!
		const record = byId.get(row.id)!
		assert.strictEqual(record.body.stringValue, row.event_message)
		assert.strictEqual(attributeMap(record.attributes).msg, row.log_attributes.msg)
	})

	it("stamps the project and the connection's source on the resource", () => {
		assert.deepStrictEqual(attributeMap(payload.resourceLogs[0]!.resource.attributes), {
			"service.name": "supabase",
			"supabase.project.ref": "abcdefghijklmnopqrst",
			"supabase.project.name": "app",
			"supabase.project.region": "eu-central-1",
			"supabase.organization.slug": "acme",
			maple_source_id: "src_test",
		})
	})

	it("drops rows without an id or a parseable time", () => {
		const records = otlp([
			{ timestamp: "2026-10-21T17:00:00", source: "edge_logs", event_message: "no id" },
			{ id: "y", timestamp: "not a time", source: "edge_logs", event_message: "bad time" },
		]).resourceLogs[0]!.scopeLogs[0]!.logRecords
		assert.strictEqual(records.length, 0)
	})
})

describe("advanceWatermark", () => {
	const window = { startMs: Date.UTC(2026, 9, 21, 17, 0), endMs: Date.UTC(2026, 9, 21, 17, 30) }
	const rowsAt = (ms: ReadonlyArray<number>) =>
		decodeLogRows(
			ms.map((at, index) => ({
				id: `r-${String(index).padStart(4, "0")}`,
				timestamp: new Date(at).toISOString().replace("Z", "000"),
				source: "auth_logs",
				event_message: "",
			})),
		)

	it("finishes the window on a short page", () => {
		const rows = rowsAt([window.startMs + 10])
		assert.deepStrictEqual(advanceWatermark(window, rows.length, rows, rows.length), {
			watermarkAt: window.endMs,
			boundaryIds: [],
		})
	})

	it("stops a full page at its last millisecond and remembers every id read in it", () => {
		const last = window.startMs + 5_000
		const rows = rowsAt([
			...Array.from({ length: LOGS_PAGE_SIZE - 2 }, (_, i) => window.startMs + i),
			last,
			last,
		])
		assert.deepStrictEqual(advanceWatermark(window, rows.length, rows, rows.length), {
			watermarkAt: last,
			boundaryIds: ["r-0998", "r-0999"],
		})
	})

	it("steps past a millisecond holding more than a page of already-sent rows", () => {
		const rows = rowsAt(Array.from({ length: LOGS_PAGE_SIZE }, () => window.startMs))
		assert.deepStrictEqual(advanceWatermark(window, rows.length, rows, 0), {
			watermarkAt: window.startMs + 1,
			boundaryIds: [],
		})
	})
})
