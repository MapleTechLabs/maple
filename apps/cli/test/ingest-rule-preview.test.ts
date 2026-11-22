// The ingest rule dry run on a real ClickHouse: the compiled match counts over stored logs and
// spans must say what the gateway's rule semantics say about the same records
// (`docs/ingest-rules.md`): missing attributes, severity derived from text, span kind spellings.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { OrgId } from "@maple/domain"
import type { IngestRuleCondition } from "@maple/domain/ingest-rules"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { Array as Arr, Record as Rec, Schema, String as Str } from "effect"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_rules"
const OTHER_ORG = "org_other"
const AT = "2026-11-20 10:00:00.000000000"
const params = {
	orgId: Schema.decodeSync(OrgId)(ORG),
	startTime: "2026-11-20 00:00:00",
	endTime: "2026-11-21 00:00:00",
}

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`
const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

interface LogRow {
	readonly org?: string
	readonly service: string
	readonly severityNumber: number
	readonly severityText: string
	readonly body: string
	readonly attributes?: Readonly<Record<string, string>>
	readonly resource?: Readonly<Record<string, string>>
}

interface SpanRow {
	readonly service: string
	readonly name: string
	readonly kind: string
	readonly status: string
	readonly attributes?: Readonly<Record<string, string>>
}

const LOGS: ReadonlyArray<LogRow> = [
	{ service: "checkout", severityNumber: 5, severityText: "DEBUG", body: "cache warm" },
	{ service: "checkout", severityNumber: 0, severityText: "debug", body: "retrying" },
	{ service: "checkout", severityNumber: 0, severityText: "Warning", body: "slow" },
	{ service: "checkout", severityNumber: 0, severityText: "", body: "no level" },
	{
		service: "checkout",
		severityNumber: 9,
		severityText: "INFO",
		body: "order placed by ana@example.com",
		attributes: { "user.id": "u1" },
	},
	{
		service: "api",
		severityNumber: 9,
		severityText: "INFO",
		body: "GET /healthz 200",
		attributes: { "http.route": "/healthz" },
		resource: { "deployment.environment": "staging" },
	},
	{
		service: "api",
		severityNumber: 17,
		severityText: "ERROR",
		body: "boom",
		attributes: { "user.id": "" },
	},
	{ org: OTHER_ORG, service: "checkout", severityNumber: 5, severityText: "DEBUG", body: "not ours" },
]

const SPANS: ReadonlyArray<SpanRow> = [
	{ service: "api", name: "GET /healthz", kind: "Server", status: "Unset" },
	{ service: "api", name: "GET /orders", kind: "SPAN_KIND_SERVER", status: "Error" },
	{
		service: "api",
		name: "SELECT orders",
		kind: "Client",
		status: "Ok",
		attributes: { "db.system": "postgresql" },
	},
	{ service: "worker", name: "tick", kind: "Internal", status: "STATUS_CODE_ERROR" },
]

let dir = ""
let db: Chdb

const insert = () => {
	db.exec(
		`INSERT INTO logs (OrgId, Timestamp, TimestampTime, ServiceName, SeverityNumber, SeverityText, Body, LogAttributes, ResourceAttributes) VALUES ${Arr.join(
			Arr.map(
				LOGS,
				(row) =>
					`(${quote(row.org ?? ORG)}, ${quote(AT)}, ${quote(Str.slice(0, 19)(AT))}, ${quote(row.service)}, ${row.severityNumber}, ${quote(row.severityText)}, ${quote(row.body)}, ${mapLiteral(row.attributes ?? {})}, ${mapLiteral(row.resource ?? {})})`,
			),
			", ",
		)}`,
	)
	db.exec(
		`INSERT INTO traces (OrgId, Timestamp, ServiceName, SpanName, SpanKind, StatusCode, SpanAttributes, ResourceAttributes) VALUES ${Arr.join(
			Arr.map(
				SPANS,
				(row) =>
					`(${quote(ORG)}, ${quote(AT)}, ${quote(row.service)}, ${quote(row.name)}, ${quote(row.kind)}, ${quote(row.status)}, ${mapLiteral(row.attributes ?? {})}, map())`,
			),
			", ",
		)}`,
	)
}

type Counts = Readonly<Record<string, { readonly total: number; readonly matched: number }>>

const decodeRows = decodeJsonEachRow(
	Schema.Struct({ serviceName: Schema.String, total: CH.CHNumber, matched: CH.CHNumber }),
)

const byService = (json: string): Counts =>
	Rec.fromEntries(
		Arr.map(
			decodeRows(json),
			(row) => [row.serviceName, { total: row.total, matched: row.matched }] as const,
		),
	)

const logMatches = (conditions: ReadonlyArray<IngestRuleCondition>): Counts =>
	byService(
		db.query(
			normalizeSqlForClickHouseClient(
				CH.compileUnsafe(CH.ingestRuleLogMatchesQuery({ conditions }), params).sql,
			),
		),
	)

const spanMatches = (conditions: ReadonlyArray<IngestRuleCondition>): Counts =>
	byService(
		db.query(
			normalizeSqlForClickHouseClient(
				CH.compileUnsafe(CH.ingestRuleSpanMatchesQuery({ conditions }), params).sql,
			),
		),
	)

const matched = (counts: Counts) => Rec.map(counts, (entry) => entry.matched)

describeWithChdb("ingest rule dry run on chDB", () => {
	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "maple-ingest-rule-preview-"))
		db = Chdb.open({ dataDir: dir, schemaSql })
		insert()
	})
	afterAll(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})

	test("no conditions match every stored record of the org, per service", () => {
		expect(logMatches([])).toEqual({ checkout: { total: 5, matched: 5 }, api: { total: 2, matched: 2 } })
	})

	test("severity below info counts the text-only debug line and skips unknown levels", () => {
		expect(matched(logMatches([{ field: "severity", op: "lt", value: "info" }]))).toEqual({
			checkout: 2,
			api: 0,
		})
		expect(matched(logMatches([{ field: "severity", op: "gte", value: "warn" }]))).toEqual({
			checkout: 1,
			api: 1,
		})
	})

	test("a missing attribute fails eq and passes neq, not_in and not_exists", () => {
		const attr = (op: IngestRuleCondition["op"], extra: Partial<IngestRuleCondition> = {}) =>
			matched(logMatches([{ field: "attribute", key: "user.id", op, ...extra }]))
		expect(attr("eq", { value: "u1" })).toEqual({ checkout: 1, api: 0 })
		expect(attr("neq", { value: "u1" })).toEqual({ checkout: 4, api: 2 })
		expect(attr("not_in", { values: ["u1"] })).toEqual({ checkout: 4, api: 2 })
		// An empty value is still present.
		expect(attr("exists")).toEqual({ checkout: 1, api: 1 })
		expect(attr("not_exists")).toEqual({ checkout: 4, api: 1 })
	})

	test("body, resource attribute and service conditions combine with and", () => {
		expect(
			matched(
				logMatches([
					{ field: "service_name", op: "eq", value: "api" },
					{
						field: "resource_attribute",
						key: "deployment.environment",
						op: "in",
						values: ["staging"],
					},
					{ field: "body", op: "regex", value: "^GET /health" },
				]),
			),
		).toEqual({ checkout: 0, api: 1 })
		expect(matched(logMatches([{ field: "body", op: "contains", value: "@example.com" }]))).toEqual({
			checkout: 1,
			api: 0,
		})
		expect(matched(logMatches([{ field: "body", op: "prefix", value: "50%" }]))).toEqual({
			checkout: 0,
			api: 0,
		})
	})

	test("span kind and status read either spelling, lower-cased", () => {
		expect(matched(spanMatches([{ field: "span_kind", op: "in", values: ["server"] }]))).toEqual({
			api: 2,
			worker: 0,
		})
		expect(matched(spanMatches([{ field: "span_status", op: "in", values: ["error"] }]))).toEqual({
			api: 1,
			worker: 1,
		})
		expect(
			matched(
				spanMatches([
					{ field: "name", op: "prefix", value: "GET " },
					{ field: "attribute", key: "db.system", op: "not_exists" },
				]),
			),
		).toEqual({ api: 2, worker: 0 })
	})

	test("the suggestion rollups rank stored logs by service and level, and spans by name", () => {
		const logRows = decodeJsonEachRow(
			Schema.Struct({
				serviceName: Schema.String,
				level: Schema.String,
				records: CH.CHNumber,
				bytes: CH.CHNumber,
			}),
		)(
			db.query(
				normalizeSqlForClickHouseClient(CH.compileUnsafe(CH.ingestRuleLogVolumeQuery(), params).sql),
			),
		)
		const levels = Rec.fromEntries(
			Arr.map(logRows, (row) => [`${row.serviceName}/${row.level}`, row.records] as const),
		)
		// The rollup keeps only the text: DEBUG and debug are debug; Warning and an empty level are other.
		expect(levels).toEqual({
			"checkout/debug": 2,
			"checkout/info": 1,
			"checkout/other": 2,
			"api/info": 1,
			"api/other": 1,
		})
		expect(Arr.every(logRows, (row) => row.bytes > 0)).toBe(true)

		const spanRows = decodeJsonEachRow(
			Schema.Struct({ serviceName: Schema.String, spanName: Schema.String, records: CH.CHNumber }),
		)(
			db.query(
				normalizeSqlForClickHouseClient(CH.compileUnsafe(CH.ingestRuleSpanVolumeQuery(), params).sql),
			),
		)
		expect(
			Arr.map(spanRows, (row) => `${row.serviceName} ${row.spanName} ${row.records}`).sort(),
		).toEqual(["api GET /healthz 1", "api GET /orders 1", "api SELECT orders 1", "worker tick 1"])
	})
})
