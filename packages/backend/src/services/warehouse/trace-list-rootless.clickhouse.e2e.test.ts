// SAFETY-FILE: JSON in this test is emitted by ClickHouse before its fields are asserted.
// A trace whose root span never reaches Maple has no row in `trace_list_mv`.
// This proves rows, on a database built from the real migration chain: such a
// trace is listed once through `trace_list_entry_spans`, by the list, its
// facets, the trace search and the slow-traces query, and a trace that does
// have a root is listed exactly as it was.

import { afterAll, assert, beforeAll, describe, it } from "@effect/vitest"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import {
	applyRealMigrations,
	clickhouseE2eEnabled,
	clickhouseExec,
	uniqueDatabase,
} from "./clickhouse-e2e-support"

const database = uniqueDatabase("maple_trace_rootless_e2e")
const ORG_ID = "org_trace_rootless_e2e"

// Anchored to now: `traces` carries a 30-day TTL enforced at insert.
const HOUR_MS = 3_600_000
const BASE_MS = Math.floor((Date.now() - 3 * HOUR_MS) / HOUR_MS) * HOUR_MS
const MS = 1_000_000

const chDateTime = (epochMs: number): string => new Date(epochMs).toISOString().replace("T", " ").slice(0, 19)
const window = { orgId: ORG_ID, startTime: chDateTime(BASE_MS), endTime: chDateTime(BASE_MS + HOUR_MS) }

interface SeedSpan {
	readonly traceId: string
	readonly spanId: string
	readonly parentSpanId: string
	readonly second: number
	readonly service: string
	readonly kind: string
	readonly durationNs: number
	readonly status?: string
}

const span = (
	traceId: string,
	spanId: string,
	parentSpanId: string,
	second: number,
	service: string,
	kind: string,
	durationMs: number,
	status?: string,
): SeedSpan => ({ traceId, spanId, parentSpanId, second, service, kind, durationNs: durationMs * MS, status })

const SEED: ReadonlyArray<SeedSpan> = [
	// A root and a downstream Server span: the entry span must never list the trace.
	span("t-rooted", "root-1", "", 600, "web", "Server", 5),
	span("t-rooted", "api-1", "client-1", 601, "api", "Server", 3),
	// One service behind a proxy that never exports the parent.
	span("t-proxy", "checkout-1", "proxy-1", 1200, "checkout", "Server", 50),
	span("t-proxy", "checkout-2", "checkout-1", 1201, "checkout", "Internal", 1),
	// Two services, each behind such a proxy, three seconds apart.
	span("t-two-hops", "gateway-1", "proxy-2", 1800, "gateway", "Server", 30),
	span("t-two-hops", "billing-1", "proxy-3", 1803, "billing", "Server", 200, "Error"),
	// Its root arrives later (see LATE_ROOT).
	span("t-late-root", "orders-1", "edge-1", 2400, "orders", "Server", 10),
	// No root and no entry span: readable by id, but nothing can stand in for it.
	span("t-internal-only", "cron-1", "gone-1", 3000, "cron", "Internal", 7),
]
const LATE_ROOT = span("t-late-root", "edge-1", "", 2399, "edge", "Server", 20)

const insert = async (spans: ReadonlyArray<SeedSpan>): Promise<void> => {
	const rows = spans
		.map(
			(s) =>
				`('${ORG_ID}', '${chDateTime(BASE_MS + s.second * 1000)}', '${s.traceId}', '${s.spanId}', '${s.parentSpanId}', 'op-${s.service}', '${s.kind}', '${s.service}', ${s.durationNs}, '${s.status ?? "Ok"}', '', 1, map(), map())`,
		)
		.join("\n,")
	await clickhouseExec(
		`INSERT INTO traces
		 (OrgId, Timestamp, TraceId, SpanId, ParentSpanId, SpanName, SpanKind, ServiceName, Duration, StatusCode, StatusMessage, SampleRate, SpanAttributes, ResourceAttributes)
		 VALUES\n${rows}`,
		database,
	)
}

const run = async (sql: string): Promise<ReadonlyArray<Record<string, unknown>>> => {
	const body = await clickhouseExec(`${normalizeSqlForClickHouseClient(sql)} FORMAT JSON`, database, {
		output_format_json_quote_64bit_integers: "0",
	})
	return (JSON.parse(body) as { readonly data?: ReadonlyArray<Record<string, unknown>> }).data ?? []
}

const list = (opts: CH.TraceListOpts = {}) => run(CH.compileUnsafe(CH.traceListQuery(opts), window).sql)
const traceIds = (rows: ReadonlyArray<Record<string, unknown>>) => rows.map((row) => row.traceId)
const serviceFacet = async (opts: Parameters<typeof CH.tracesFacetsQuery>[0] = {}) => {
	const rows = await run(
		CH.compileUnionUnsafe(CH.tracesFacetsQuery({ ...opts, facet: "service" }), window).sql,
	)
	return Object.fromEntries(rows.map((row) => [row.name, Number(row.count)]))
}

describe.skipIf(!clickhouseE2eEnabled)("traces with no root span", () => {
	beforeAll(async () => {
		await clickhouseExec(`CREATE DATABASE ${database}`)
		await applyRealMigrations(database)
		await insert(SEED)
	}, 180_000)

	afterAll(async () => {
		await clickhouseExec(`DROP DATABASE IF EXISTS ${database}`)
	}, 30_000)

	it("lists each once, newest first, beside the rooted trace", async () => {
		const rows = await list()
		assert.deepStrictEqual(traceIds(rows), ["t-late-root", "t-two-hops", "t-proxy", "t-rooted"])

		const twoHops = rows[1]!
		// Shown as its first span, with every span and service of the trace.
		assert.strictEqual(twoHops.rootSpanName, "op-gateway")
		assert.deepStrictEqual(twoHops.services, ["gateway", "billing"])
		assert.strictEqual(Number(twoHops.spanCount), 2)
		assert.strictEqual(Number(rows[2]!.spanCount), 2)

		// The rooted trace is still its root, not its downstream entry span.
		assert.strictEqual(rows[3]!.rootSpanName, "op-web")
		assert.deepStrictEqual(rows[3]!.services, ["web", "api"])
	})

	it("pages without repeating or skipping a trace", async () => {
		const seen: Array<unknown> = []
		for (let offset = 0; offset < 5; offset++) seen.push(...traceIds(await list({ limit: 1, offset })))
		assert.deepStrictEqual(seen, ["t-late-root", "t-two-hops", "t-proxy", "t-rooted"])
		// Within a page, a trace sorts by its first span's own duration (30 ms for `t-two-hops`).
		assert.deepStrictEqual(traceIds(await list({ sortBy: "durationMs", sortDir: "desc" })), [
			"t-proxy",
			"t-two-hops",
			"t-late-root",
			"t-rooted",
		])
	})

	it("matches a rootless trace through any of its entry spans, and a rooted one through its root only", async () => {
		assert.deepStrictEqual(traceIds(await list({ serviceName: "billing" })), ["t-two-hops"])
		assert.deepStrictEqual(traceIds(await list({ serviceName: "gateway" })), ["t-two-hops"])
		assert.deepStrictEqual(traceIds(await list({ serviceName: "web" })), ["t-rooted"])
		assert.deepStrictEqual(traceIds(await list({ serviceName: "api" })), [])
		// The raw-`traces` page (a filter the list tables cannot express) agrees.
		const everySpan = [{ key: "missing", mode: "equals" as const, value: "x", negated: true }]
		assert.deepStrictEqual(traceIds(await list({ attributeFilters: everySpan })), [
			"t-late-root",
			"t-two-hops",
			"t-proxy",
			"t-rooted",
		])
		assert.deepStrictEqual(traceIds(await list({ rootsOnly: true })), ["t-rooted"])
	})

	it("counts them in the facets and duration stats the list is filtered by", async () => {
		// One per service a click on the facet would list; `api` is not a way into any trace.
		assert.deepStrictEqual(await serviceFacet(), {
			web: 1,
			checkout: 1,
			gateway: 1,
			billing: 1,
			orders: 1,
		})
		assert.deepStrictEqual(await serviceFacet({ rawOnly: true }), { web: 1 })

		const [stats] = await run(CH.compileUnsafe(CH.tracesDurationStatsQuery({}), window).sql)
		assert.strictEqual(Number(stats!.minDurationMs), 5)
		assert.strictEqual(Number(stats!.maxDurationMs), 200)
	})

	it("returns them from the trace search and the slow-traces query", async () => {
		const summaries = await run(CH.compileUnsafe(CH.traceSummariesQuery({}), window).sql)
		assert.deepStrictEqual(traceIds(summaries), ["t-late-root", "t-two-hops", "t-proxy", "t-rooted"])
		// Summarized by its earliest entry span; the error is the later one's.
		assert.strictEqual(summaries[1]!.rootServiceName, "gateway")
		assert.strictEqual(Number(summaries[1]!.hasError), 1)
		const filtered = await run(
			CH.compileUnsafe(CH.traceSummariesQuery({ serviceName: "billing" }), window).sql,
		)
		assert.deepStrictEqual(traceIds(filtered), ["t-two-hops"])

		const slow = await run(CH.compileUnsafe(CH.slowTracesQuery({ limit: 3 }), window).sql)
		// One row per trace: `t-two-hops` by its slowest entry span, not also by the 30 ms one.
		assert.deepStrictEqual(
			slow.map((row) => [row.traceId, row.serviceName, Number(row.durationMs)]),
			[
				["t-two-hops", "billing", 200],
				["t-proxy", "checkout", 50],
				["t-late-root", "orders", 10],
			],
		)
	})

	it("lists a trace under its root once the root arrives", async () => {
		await insert([LATE_ROOT])

		const rows = await list()
		assert.deepStrictEqual(traceIds(rows), ["t-late-root", "t-two-hops", "t-proxy", "t-rooted"])
		assert.strictEqual(rows[0]!.rootSpanName, "op-edge")
		assert.deepStrictEqual(rows[0]!.services, ["edge", "orders"])
		assert.deepStrictEqual(await serviceFacet(), { web: 1, checkout: 1, gateway: 1, billing: 1, edge: 1 })
		assert.deepStrictEqual(traceIds(await list({ serviceName: "orders" })), [])

		const summaries = await run(CH.compileUnsafe(CH.traceSummariesQuery({}), window).sql)
		assert.strictEqual(summaries[0]!.rootServiceName, "edge")
	})
})
