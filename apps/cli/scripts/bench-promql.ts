/**
 * PromQL on the warehouse at volume, on chDB.
 *
 *   MAPLE_TELEMETRY=off bun run scripts/bench-promql.ts [--series 1000] [--hours 24]
 *
 * Loads a counter with `--series` series and a 12-bucket histogram with a fifth of
 * that, scraped every 15 s for `--hours`, plus an unrelated metric of the same size
 * the scan must skip. Times each query's SQL (per selector) and evaluation.
 */
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import * as CH from "@maple/query-engine/ch"
import {
	buildPushdownQuery,
	buildSelectorQueries,
	catalogFromRows,
	catalogQuery,
	promqlCatalogRowSchema,
	promqlPushdownRowSchema,
	promqlSelectorRowSchema,
	toPushdownData,
	toSelectorData,
} from "@maple/query-engine/promql"
import {
	evaluate,
	type Expr,
	parse,
	planPushdowns,
	planRequests,
	type PushdownData,
	type SelectorData,
	type VectorSelector,
} from "@maple/promql"
import { OrgId } from "@maple/domain"

const arg = (name: string, fallback: number): number => {
	const index = process.argv.indexOf(`--${name}`)
	return index === -1 ? fallback : Number(process.argv[index + 1])
}
const SERIES = arg("series", 1000)
const HOURS = arg("hours", 24)
const ORG = "org_bench"
const HOUR_MS = 3_600_000
const END = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - HOUR_MS
const START = END - HOURS * HOUR_MS
const POINTS = (HOURS * HOUR_MS) / 15_000

const root = mkdtempSync(join(tmpdir(), "maple-promql-bench-"))
const db = Chdb.open({ dataDir: join(root, "data"), schemaSql })

const time = <A>(f: () => A): [A, number] => {
	const t0 = performance.now()
	const out = f()
	return [out, performance.now() - t0]
}

const load = () => {
	const ts = `fromUnixTimestamp64Milli(toInt64(${START} + (number % ${POINTS}) * 15000))`
	const counter = (name: string) => `
		INSERT INTO metrics_sum (OrgId, ResourceAttributes, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value, AggregationTemporality, IsMonotonic)
		SELECT '${ORG}', map('service.name', 'svc-' || toString(intDiv(number, ${POINTS}) % 10), 'k8s.pod.name', 'pod-' || toString(intDiv(number, ${POINTS}))),
			'svc-' || toString(intDiv(number, ${POINTS}) % 10), '${name}',
			map('route', '/r' || toString(intDiv(number, ${POINTS}) % 50), 'status', toString(200 + (intDiv(number, ${POINTS}) % 4) * 100)),
			fromUnixTimestamp64Milli(toInt64(${START - HOUR_MS})), ${ts},
			toFloat64((number % ${POINTS}) * (1 + intDiv(number, ${POINTS}) % 7)), 2, true
		FROM numbers(${SERIES * POINTS})`
	db.exec(counter("http_requests_total"))
	db.exec(counter("other_requests_total"))
	db.exec(`
		INSERT INTO metrics_histogram (OrgId, ResourceAttributes, ServiceName, MetricName, MetricUnit, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality)
		SELECT '${ORG}', map('service.name', 'svc-' || toString(intDiv(number, ${POINTS}) % 10), 'k8s.pod.name', 'pod-' || toString(intDiv(number, ${POINTS}))), 'svc-' || toString(intDiv(number, ${POINTS}) % 10),
			'http.server.request.duration', 's', map('http.route', '/r' || toString(intDiv(number, ${POINTS}) % 50)),
			fromUnixTimestamp64Milli(toInt64(${START - HOUR_MS})), ${ts},
			(number % ${POINTS}) * 12, toFloat64(number % ${POINTS}) * 3.5,
			arrayMap(i -> toUInt64(number % ${POINTS}), range(12)),
			[0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5], 2
		FROM numbers(${Math.max(1, Math.floor(SERIES / 5)) * POINTS})`)
}

const [, loadMs] = time(load)
console.log(
	`loaded ${(SERIES * POINTS * 2 + Math.floor(SERIES / 5) * POINTS).toLocaleString()} rows in ${(loadMs / 1000).toFixed(1)}s`,
)

const catalogRows = decodeJsonEachRow(promqlCatalogRowSchema)(
	db.query(
		normalizeSqlForClickHouseClient(
			CH.compileUnsafe(catalogQuery(), {
				orgId: OrgId.make(ORG),
				startTime: new Date(START - 2 * HOUR_MS).toISOString().slice(0, 19).replace("T", " "),
				endTime: new Date(END + HOUR_MS).toISOString().slice(0, 19).replace("T", " "),
			}).sql,
		),
	),
)
const catalog = catalogFromRows(catalogRows)
const decodeRows = decodeJsonEachRow(promqlSelectorRowSchema)

const decodePushdown = decodeJsonEachRow(promqlPushdownRowSchema)
const pushdownEnabled = !process.argv.includes("--no-pushdown")

const run = (query: string, params: { startMs: number; endMs: number; stepMs: number }) => {
	const parsed = parse(query)
	if (Result.isFailure(parsed)) throw new Error(parsed.failure.message)
	const data = new Map<VectorSelector, SelectorData>()
	const pushed = new Map<Expr, PushdownData>()
	const skipped = new Set<VectorSelector>()
	let sqlMs = 0
	let rows = 0
	let buckets = 0
	let jsonBytes = 0
	for (const [node, candidate] of pushdownEnabled ? planPushdowns(parsed.success, params) : []) {
		const plan = buildPushdownQuery(candidate.request, catalog, {
			orgId: OrgId.make(ORG),
			maxSeries: 10_000,
		})
		if (plan === undefined) continue
		const sql = normalizeSqlForClickHouseClient(Effect.runSync(plan.compiled).sql)
		const [raw, ms] = time(() => db.query(sql))
		sqlMs += ms
		jsonBytes += raw.length
		const decoded = decodePushdown(raw)
		rows += decoded.length
		for (const r of decoded) buckets += r.values.length
		pushed.set(node, toPushdownData(candidate.request, plan, decoded))
		skipped.add(candidate.selector)
	}
	for (const [selector, request] of planRequests(parsed.success, params)) {
		if (skipped.has(selector)) continue
		const results = buildSelectorQueries(request, catalog, {
			orgId: OrgId.make(ORG),
			maxSeries: 10_000,
		}).map((plan) => {
			const sql = normalizeSqlForClickHouseClient(Effect.runSync(plan.compiled).sql)
			const [raw, ms] = time(() => db.query(sql))
			sqlMs += ms
			jsonBytes += typeof raw === "string" ? raw.length : JSON.stringify(raw).length
			const decoded = decodeRows(raw)
			rows += decoded.length
			return { plan, rows: decoded }
		})
		const selectorData = toSelectorData(request, results)
		for (const s of selectorData.series) buckets += s.buckets.length
		data.set(selector, selectorData)
	}
	Bun.gc(true)
	const heapMb = process.memoryUsage().heapUsed / 1e6
	const [result, evalMs] = time(() => evaluate({ expr: parsed.success, params, data, pushed }))
	if (Result.isFailure(result)) throw new Error(result.failure.message)
	const out = result.success
	const outSeries = out.resultType === "matrix" || out.resultType === "vector" ? out.result.length : 1
	Bun.gc(true)
	const afterMb = process.memoryUsage().heapUsed / 1e6
	return { sqlMs, evalMs, rows, buckets, outSeries, heapMb, afterMb, jsonMb: jsonBytes / 1e6 }
}

const cases: Array<[string, string, { startMs: number; endMs: number; stepMs: number }]> = [
	[
		"24h step 5m",
		"sum by (route) (rate(http_requests_total[5m]))",
		{ startMs: START + HOUR_MS, endMs: END, stepMs: 300_000 },
	],
	[
		"24h step 60s",
		"sum by (status) (rate(http_requests_total[$r]))".replace("$r", "4m"),
		{ startMs: START + HOUR_MS, endMs: END, stepMs: 60_000 },
	],
	[
		"1h step 15s",
		'sum by (route) (rate(http_requests_total{status="200"}[1m]))',
		{ startMs: END - HOUR_MS, endMs: END, stepMs: 15_000 },
	],
	[
		"6h p95",
		"histogram_quantile(0.95, sum by (le, http_route) (rate(http_server_request_duration_seconds_bucket[5m])))",
		{ startMs: END - 6 * HOUR_MS, endMs: END, stepMs: 60_000 },
	],
	[
		"instant",
		"topk(5, sum by (k8s_pod_name) (increase(http_requests_total[1h])))",
		{ startMs: END, endMs: END, stepMs: 0 },
	],
	[
		"regex 6h",
		'sum(rate(http_requests_total{route=~"/r1.*"}[5m]))',
		{ startMs: END - 6 * HOUR_MS, endMs: END, stepMs: 60_000 },
	],
]

for (const [name, query, params] of cases) {
	run(query, params)
	const r = run(query, params)
	console.log(
		`${name.padEnd(12)} sql ${r.sqlMs.toFixed(0).padStart(6)}ms  eval ${r.evalMs.toFixed(0).padStart(5)}ms  rows ${String(r.rows).padStart(5)}  buckets ${String(r.buckets).padStart(8)}  out ${r.outSeries}  json ${r.jsonMb.toFixed(0)}MB heap ${r.heapMb.toFixed(0)}->${r.afterMb.toFixed(0)}MB  ${query}`,
	)
}
db.close()
rmSync(root, { recursive: true, force: true })
