// `searchTraces` (the MCP search_traces tool) through the real executor on chDB: `has_error`
// is tri-state at span and root level, and a bare `trace_id` narrows the root-level search.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Schema, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { OrgId, UserId } from "@maple/domain/http"
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import {
	makeWarehouseExecutor,
	normalizeSqlForClickHouseClient,
	type WarehouseSqlClient,
	WarehouseDriverError,
} from "@maple/query-engine/execution"
import { searchTraces, WarehouseExecutor, type SearchTracesInput } from "@maple/query-engine/observability"
import { describeWithChdb } from "./libchdb-test-support"

const ORG_ID = Schema.decodeSync(OrgId)("org_search_traces_filters")
const OTHER_ORG_ID = "org_search_traces_other"
const HOUR_MS = 3_600_000
const DAY_MS = 24 * HOUR_MS
/** Anchored to now: the tables' TTL drops rows older than their horizon at insert. */
const BASE_MS = Math.floor((Date.now() - 2 * DAY_MS) / DAY_MS) * DAY_MS
const at = (hours: number): string =>
	Str.slice(0, 19)(Str.replace("T", " ")(new Date(BASE_MS + hours * HOUR_MS).toISOString()))

const OK_TRACE = "0af7651916cd43dd8448eb211c80319a"
const ERROR_TRACE = "0af7651916cd43dd8448eb211c80319b"
const OTHER_ORG_TRACE = "0af7651916cd43dd8448eb211c80319c"
const SPAN_NAME = "POST /checkout"

const quote = (value: string) => `'${Str.replace(/[\\']/g, "\\$&")(value)}'`

interface SeedSpan {
	readonly orgId: string
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly spanName: string
	readonly spanKind: string
	readonly serviceName: string
	readonly statusCode: "Ok" | "Error"
	readonly hour: number
}

const row = (s: SeedSpan) =>
	`(${quote(s.orgId)}, ${quote(at(s.hour))}, ${quote(s.traceId)}, ${quote(s.spanId)}, ${quote(s.parentSpanId)}, ${quote(s.spanName)}, ${quote(s.spanKind)}, ${quote(s.serviceName)}, 1000000, ${quote(s.statusCode)}, 1, '', map(), map())`

// Each trace has a root, an internal child and a downstream Server span, all with the same
// name and status: span level sees three rows per trace, root level the two entry spans.
const traceSpans = (orgId: string, traceId: string, statusCode: "Ok" | "Error", hour: number) => [
	row({
		orgId,
		traceId,
		spanId: `${Str.slice(0, 15)(traceId)}1`,
		parentSpanId: "",
		spanName: SPAN_NAME,
		spanKind: "Server",
		serviceName: "api",
		statusCode,
		hour,
	}),
	row({
		orgId,
		traceId,
		spanId: `${Str.slice(0, 15)(traceId)}2`,
		parentSpanId: `${Str.slice(0, 15)(traceId)}1`,
		spanName: SPAN_NAME,
		spanKind: "Internal",
		serviceName: "api",
		statusCode,
		hour,
	}),
	row({
		orgId,
		traceId,
		spanId: `${Str.slice(0, 15)(traceId)}3`,
		parentSpanId: `${Str.slice(0, 15)(traceId)}2`,
		spanName: SPAN_NAME,
		spanKind: "Server",
		serviceName: "payments",
		statusCode,
		hour,
	}),
]

const decodeRows = decodeJsonEachRow(Schema.Record(Schema.String, Schema.Unknown))

describeWithChdb("search_traces filters on chDB", () => {
	let root: string | undefined
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-search-traces-filters-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		db.exec(
			`INSERT INTO traces (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, SampleRate, TraceState, SpanAttributes, ResourceAttributes) VALUES ${Arr.join(
				[
					...traceSpans(ORG_ID, OK_TRACE, "Ok", 3),
					...traceSpans(ORG_ID, ERROR_TRACE, "Error", 5),
					// Another tenant's trace: never visible, even by its id.
					...traceSpans(OTHER_ORG_ID, OTHER_ORG_TRACE, "Ok", 4),
				],
				", ",
			)}`,
		)
	})

	afterAll(() => {
		db?.close()
		if (root !== undefined) rmSync(root, { recursive: true, force: true })
	})

	const client = (): WarehouseSqlClient => ({
		sql: (statement) =>
			Effect.sync(() => ({
				data: decodeRows(db.query(normalizeSqlForClickHouseClient(statement.text))),
			})),
		insert: () => Effect.fail(new WarehouseDriverError({ reason: "config", message: "read-only test" })),
	})

	const search = (input: Omit<SearchTracesInput, "timeRange">) => {
		const executor = makeWarehouseExecutor({
			createClient: () => Effect.succeed(client()),
			resolveRoute: () =>
				Effect.succeed({
					source: "managed" as const,
					config: {
						kind: "chdb" as const,
						url: "",
						username: "",
						password: "",
						database: "default",
					},
					clientCacheKey: "test",
				}),
		}).asExecutor({
			orgId: ORG_ID,
			userId: Schema.decodeSync(UserId)("test"),
			authMode: "local" as const,
		})
		return Effect.runPromise(
			searchTraces({ timeRange: { startTime: at(0), endTime: at(24) }, limit: 50, ...input }).pipe(
				Effect.provideService(WarehouseExecutor, executor),
				Effect.map((out) =>
					Arr.map(
						out.spans,
						(span) => `${span.traceId}:${Str.slice(-1)(span.spanId ?? "")}:${span.statusCode}`,
					).sort(),
				),
			),
		)
	}

	const okRoot = `${OK_TRACE}:1:Ok`
	const okChild = `${OK_TRACE}:2:Ok`
	const okDownstream = `${OK_TRACE}:3:Ok`
	const errRoot = `${ERROR_TRACE}:1:Error`
	const errChild = `${ERROR_TRACE}:2:Error`
	const errDownstream = `${ERROR_TRACE}:3:Error`
	const okSpans = [okRoot, okChild, okDownstream]
	const errSpans = [errRoot, errChild, errDownstream]
	const sorted = (spans: ReadonlyArray<string>) => [...spans].sort()

	test("span level: has_error unset returns both statuses, true only Error, false only Ok", async () => {
		expect(await search({ spanName: SPAN_NAME })).toEqual(sorted([...okSpans, ...errSpans]))
		expect(await search({ spanName: SPAN_NAME, hasError: true })).toEqual(sorted(errSpans))
		expect(await search({ spanName: SPAN_NAME, hasError: false })).toEqual(sorted(okSpans))
	})

	test("span level with a trace id applies has_error the same way", async () => {
		expect(await search({ spanName: SPAN_NAME, traceId: ERROR_TRACE, hasError: false })).toEqual([])
		expect(await search({ spanName: SPAN_NAME, traceId: OK_TRACE, hasError: false })).toEqual(
			sorted(okSpans),
		)
	})

	test("root level: has_error unset returns both traces, true only Error, false only Ok", async () => {
		expect(await search({})).toEqual(sorted([okRoot, okDownstream, errRoot, errDownstream]))
		expect(await search({ hasError: true })).toEqual(sorted([errRoot, errDownstream]))
		expect(await search({ hasError: false })).toEqual(sorted([okRoot, okDownstream]))
	})

	test("a bare trace_id returns only that trace's entry spans", async () => {
		expect(await search({ traceId: OK_TRACE })).toEqual(sorted([okRoot, okDownstream]))
		expect(await search({ traceId: ERROR_TRACE })).toEqual(sorted([errRoot, errDownstream]))
		expect(await search({ traceId: ERROR_TRACE, hasError: false })).toEqual([])
	})

	test("an unknown or another org's trace_id returns nothing", async () => {
		expect(await search({ traceId: "ffffffffffffffffffffffffffffffff" })).toEqual([])
		expect(await search({ traceId: OTHER_ORG_TRACE })).toEqual([])
	})
})
