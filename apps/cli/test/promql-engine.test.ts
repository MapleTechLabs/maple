// The whole PromQL path on a real ClickHouse engine (chDB): the compliance dataset is stored the
// way Maple stores it (counters in metrics_sum, gauges in metrics_gauge, the classic histogram as
// one metrics_histogram metric), every corpus query runs through the warehouse source and the
// evaluator, and the answer must equal the in-memory reference, which matches Prometheus 3.5
// (lib/promql/scripts/compliance).

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Record as Rec, Result, String as Str } from "effect"
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
	type CatalogMetric,
} from "@maple/query-engine/promql"
import {
	evaluate,
	type Expr,
	memorySource,
	parse,
	planPushdowns,
	planRequests,
	type PushdownData,
	type QueryParams,
	type QueryResult,
	type RawSeries,
	runQuery,
	type SelectorData,
	type VectorSelector,
} from "@maple/promql"
import { buildDataset, DATA_END_MS, DATA_START_MS, QUERIES } from "@maple/promql/compliance"
import { OrgId } from "@maple/domain"
import { describeWithChdb } from "./libchdb-test-support"

const ORG = "org_promql_engine"
const HOUR_MS = 3_600_000
/** The dataset moved to end on the hour two hours ago, inside every table's TTL. */
const SHIFT_MS = Math.floor(Date.now() / HOUR_MS) * HOUR_MS - 2 * HOUR_MS - DATA_END_MS
const START = DATA_START_MS + SHIFT_MS
const END = DATA_END_MS + SHIFT_MS

/** Prometheus 3 spells bucket bounds as floats; the source does too. */
const leOf = (le: string): string => (le === "1" ? "1.0" : le)

const dataset: ReadonlyArray<RawSeries> = Arr.map(buildDataset(), (s) => ({
	labels: s.labels.le === undefined ? s.labels : { ...s.labels, le: leOf(s.labels.le) },
	samples: Arr.map(s.samples, ([t, v]): readonly [number, number] => [t + SHIFT_MS, v]),
}))

const chTime = (ms: number): string => Str.replace("T", " ")(Str.slice(0, 23)(new Date(ms).toISOString()))

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const attributesOf = (labels: Readonly<Record<string, string>>): Readonly<Record<string, string>> =>
	Rec.filter(labels, (_v, k) => k !== "__name__" && k !== "le")

const rowPrefix = (name: string, labels: Readonly<Record<string, string>>): string => {
	const job = labels.job ?? "unknown"
	return `${quote(ORG)}, ${mapLiteral({ "service.name": job })}, ${quote(job)}, ${quote(name)}, ${mapLiteral(attributesOf(labels))}, ${quote(chTime(START - HOUR_MS))}`
}

const insertNumbers = (db: Chdb, series: RawSeries, table: "metrics_sum" | "metrics_gauge"): void => {
	const name = series.labels.__name__ ?? ""
	const extra = table === "metrics_sum" ? ", 2, true" : ""
	const rows = Arr.map(
		series.samples,
		([t, v]) => `(${rowPrefix(name, series.labels)}, ${quote(chTime(t))}, ${v}${extra})`,
	)
	db.exec(
		`INSERT INTO ${table} (OrgId, ResourceAttributes, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Value${
			table === "metrics_sum" ? ", AggregationTemporality, IsMonotonic" : ""
		}) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const BOUNDS = ["0.1", "0.5", "1.0"]

/** The `_bucket`/`_count`/`_sum` series of one service folded back into OTel histogram exports. */
const insertHistogram = (db: Chdb, service: string): void => {
	const of = (name: string, le?: string) =>
		Arr.findFirst(
			dataset,
			(s) => s.labels.__name__ === name && s.labels.service === service && s.labels.le === le,
		)
	const buckets = Arr.map([...BOUNDS, "+Inf"], (le) => of("http_request_duration_seconds_bucket", le))
	const sums = of("http_request_duration_seconds_sum")
	const labels = { job: "web", service }
	const rows = Arr.map(sums._tag === "Some" ? sums.value.samples : [], ([t, sum], i) => {
		const cumulative = Arr.map(buckets, (b) => (b._tag === "Some" ? (b.value.samples[i]?.[1] ?? 0) : 0))
		const counts = Arr.map(cumulative, (c, j) => c - (j === 0 ? 0 : (cumulative[j - 1] ?? 0)))
		return `(${rowPrefix("http_request_duration_seconds", labels)}, ${quote(chTime(t))}, ${cumulative[3] ?? 0}, ${sum}, [${Arr.join(Arr.map(counts, String), ", ")}], [${Arr.join(BOUNDS, ", ")}], 2)`
	})
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ResourceAttributes, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const decodeRows = decodeJsonEachRow(promqlSelectorRowSchema)
const decodePushdown = decodeJsonEachRow(promqlPushdownRowSchema)
const options = { orgId: OrgId.make(ORG), maxSeries: 10_000 }
let pushedCount = 0
const decodeCatalog = decodeJsonEachRow(promqlCatalogRowSchema)

/** The tenant scope of every compiled read; the warehouse refuses anything but single-tenant. */
const scopes = new Set<string>()
const sqlOf = (compiled: { readonly sql: string; readonly tenantScope: string }) => {
	scopes.add(compiled.tenantScope)
	return normalizeSqlForClickHouseClient(compiled.sql)
}

const sqlRun = (
	db: Chdb,
	catalog: ReadonlyArray<CatalogMetric>,
	query: string,
	params: QueryParams,
	pushdown: boolean,
) => {
	const parsed = parse(query)
	if (Result.isFailure(parsed)) return Result.fail(parsed.failure.message)
	const pushed = new Map<Expr, PushdownData>()
	const skipped = new Set<VectorSelector>()
	for (const [node, candidate] of pushdown ? planPushdowns(parsed.success, params) : []) {
		const plan = buildPushdownQuery(candidate.request, catalog, options)
		if (plan === undefined) continue
		const rows = decodePushdown(db.query(sqlOf(Effect.runSync(plan.compiled))))
		pushed.set(node, toPushdownData(candidate.request, plan, rows))
		skipped.add(candidate.selector)
		pushedCount += 1
	}
	const data = new Map<VectorSelector, SelectorData>()
	for (const [selector, request] of planRequests(parsed.success, params)) {
		if (skipped.has(selector)) continue
		const results = Arr.map(
			buildSelectorQueries(request, catalog, { orgId: OrgId.make(ORG), maxSeries: 10_000 }),
			(plan) => ({
				plan,
				rows: decodeRows(db.query(sqlOf(Effect.runSync(plan.compiled)))),
			}),
		)
		data.set(selector, toSelectorData(request, results))
	}
	return Result.mapError(evaluate({ expr: parsed.success, params, data, pushed }), (e) => e.message)
}

const flatten = (result: QueryResult): ReadonlyArray<readonly [string, number, number]> => {
	const key = (labels: Readonly<Record<string, string>>) => JSON.stringify(Rec.toEntries(labels).sort())
	switch (result.resultType) {
		case "scalar":
			return [["", result.result.t, result.result.v]]
		case "string":
			return []
		case "vector":
			return Arr.map(result.result, (s) => [key(s.labels), s.t, s.value] as const)
		case "matrix":
			return Arr.flatMap(result.result, (s) =>
				Arr.map(s.points, (p) => [key(s.labels), p.t, p.v] as const),
			)
	}
}

/** NaN and infinities compare exactly; finite values within a relative tolerance. */
const sameValue = (v: number, w: number): boolean => {
	if (Number.isNaN(v) || Number.isNaN(w)) return Number.isNaN(v) && Number.isNaN(w)
	if (!Number.isFinite(v) || !Number.isFinite(w)) return v === w
	return Math.abs(v - w) <= 1e-9 * Math.max(1, Math.abs(v), Math.abs(w))
}

/** The first point where the SQL path disagrees with the reference, or undefined. */
const mismatch = (got: QueryResult, want: QueryResult): string | undefined => {
	const sort = (rows: ReadonlyArray<readonly [string, number, number]>) =>
		[...rows].sort((a, b) => (a[0] === b[0] ? a[1] - b[1] : a[0] < b[0] ? -1 : 1))
	const a = sort(flatten(got))
	const b = sort(flatten(want))
	if (a.length !== b.length) return `${a.length} points, want ${b.length}`
	for (const [i, [k, t, v]] of a.entries()) {
		const other = b[i]
		if (other === undefined || other[0] !== k || other[1] !== t)
			return `point ${i}: ${k}@${t}, want ${other?.[0]}@${other?.[1]}`
		const w = other[2]
		if (!sameValue(v, w)) return `${k}@${t}: ${v}, want ${w}`
	}
	return undefined
}

test("the comparison tells non-finite values apart", () => {
	const scalar = (v: number): QueryResult => ({ resultType: "scalar", result: { t: 0, v } })
	expect(mismatch(scalar(Infinity), scalar(1))).toBe("@0: Infinity, want 1")
	expect(mismatch(scalar(-Infinity), scalar(Infinity))).toBe("@0: -Infinity, want Infinity")
	expect(mismatch(scalar(Number.NaN), scalar(1))).toBe("@0: NaN, want 1")
	expect(mismatch(scalar(Number.NaN), scalar(Number.NaN))).toBeUndefined()
	expect(mismatch(scalar(Infinity), scalar(Infinity))).toBeUndefined()
	expect(mismatch(scalar(1 + 1e-12), scalar(1))).toBeUndefined()
})

describeWithChdb("PromQL on the warehouse matches the reference", () => {
	let root = ""
	let db: Chdb
	let catalog: ReadonlyArray<CatalogMetric> = []
	const reference = memorySource(dataset)

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-promql-engine-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		for (const series of dataset) {
			const name = series.labels.__name__ ?? ""
			if (name === "http_requests_total") insertNumbers(db, series, "metrics_sum")
			else if (Str.startsWith("node_")(name) || Str.startsWith("room_")(name))
				insertNumbers(db, series, "metrics_gauge")
		}
		insertHistogram(db, "checkout")
		insertHistogram(db, "search")
		const compiled = CH.compileUnsafe(catalogQuery(), {
			orgId: OrgId.make(ORG),
			startTime: Str.slice(0, 19)(chTime(START - HOUR_MS)),
			endTime: Str.slice(0, 19)(chTime(END + HOUR_MS)),
		})
		catalog = catalogFromRows(decodeCatalog(db.query(normalizeSqlForClickHouseClient(compiled.sql))))
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	const cases: ReadonlyArray<{ readonly name: string; readonly params: QueryParams }> = [
		{ name: "range 60s", params: { startMs: START + 1_800_000, endMs: END - 600_000, stepMs: 60_000 } },
		{
			name: "range 37s",
			params: { startMs: START + 1_800_000, endMs: START + 5_400_000, stepMs: 37_000 },
		},
		// A step longer than most ranges, starting before the data: a series' first bucket can fall
		// between two steps' windows.
		{
			name: "range 5m from before the data",
			params: { startMs: START - 120_000, endMs: START + 3_600_000, stepMs: 300_000 },
		},
		{ name: "instant", params: { startMs: START + 3_600_000, endMs: START + 3_600_000, stepMs: 0 } },
		{
			name: "instant off-grid",
			params: { startMs: START + 3_607_000, endMs: START + 3_607_000, stepMs: 0 },
		},
	]

	for (const query of QUERIES) {
		// `@` pins absolute times, which the shifted dataset does not keep.
		if (Str.includes("@ ")(query)) continue
		test(query, () => {
			for (const { name, params } of cases) {
				const want = runQuery(query, params, reference)
				for (const pushdown of [false, true]) {
					const label = `${name}${pushdown ? " pushdown" : ""}`
					const got = sqlRun(db, catalog, query, params, pushdown)
					if (Result.isFailure(want)) {
						expect(Result.isFailure(got)).toBe(true)
						continue
					}
					if (Result.isFailure(got)) throw new Error(`${label}: ${got.failure}`)
					expect(`${label}: ${mismatch(got.success, want.success) ?? "ok"}`).toBe(`${label}: ok`)
				}
			}
		})
	}

	test("pushes most of the corpus down", () => {
		// Each corpus query runs four cases; dozens of them have a pushable subtree.
		expect(pushedCount).toBeGreaterThan(100)
	})

	test("every compiled read is single-tenant, as the warehouse requires", () => {
		expect([...scopes]).toEqual(["single-tenant"])
	})
})
