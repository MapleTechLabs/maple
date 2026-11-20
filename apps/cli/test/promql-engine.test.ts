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
	buildSeriesLabelsQueries,
	catalogFromRows,
	catalogQuery,
	promqlCatalogRowSchema,
	promqlPushdownRowSchema,
	promqlSelectorRowSchema,
	promqlSeriesLabelsRowSchema,
	toPushdownData,
	formatLe,
	toSelectorData,
	toSeriesLabels,
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
	org = ORG,
) => {
	const options = { orgId: OrgId.make(org), maxSeries: 10_000 }
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
		const results = Arr.map(buildSelectorQueries(request, catalog, options), (plan) => ({
			plan,
			rows: decodeRows(db.query(sqlOf(Effect.runSync(plan.compiled)))),
		}))
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

// Stored OTel shapes the compliance dataset has no rows for, in their own org: dotted attribute
// keys, a delta sum, NaN and infinities, a no-recorded-value point and exponential histograms.
const ORG_OTEL = "org_promql_otel"
const T0 = START + 1_800_000
const tick = (i: number): number => T0 + i * 15_000
const TICKS = Arr.range(0, 79)
const SHOP = { "service.name": "api", "service.namespace": "shop" }
const API = { "service.name": "api" }

type SqlRow = Readonly<Record<string, string>>

const insertRows = (db: Chdb, tableName: string, rows: ReadonlyArray<SqlRow>): void => {
	const columns = Rec.keys(rows[0] ?? {})
	const values = Arr.map(
		rows,
		(row) =>
			`(${Arr.join(
				Arr.map(columns, (c) => row[c] ?? "NULL"),
				", ",
			)})`,
	)
	db.exec(`INSERT INTO ${tableName} (${Arr.join(columns, ", ")}) VALUES ${Arr.join(values, ", ")}`)
}

const otelRow = (
	name: string,
	unit: string,
	resource: Readonly<Record<string, string>>,
	attributes: Readonly<Record<string, string>>,
	t: number,
): SqlRow => ({
	OrgId: quote(ORG_OTEL),
	ResourceAttributes: mapLiteral(resource),
	ServiceName: quote(resource["service.name"] ?? "unknown"),
	MetricName: quote(name),
	MetricUnit: quote(unit),
	Attributes: mapLiteral(attributes),
	StartTimeUnix: quote(chTime(START)),
	TimeUnix: quote(chTime(t)),
})

const sqlFloat = (v: number): string =>
	Number.isNaN(v) ? "nan" : v === Infinity ? "inf" : v === -Infinity ? "-inf" : String(v)

const WEIRD = [1, Infinity, Number.NaN, -Infinity, 2, 3]
/** `flaky.gauge`: a reading per tick to 39, a failed scrape at 40, readings again from 60. */
const FLAKY_TICKS = Arr.filter(TICKS, (i) => i < 40 || i >= 60)
/** Exponential histograms: (scale, offset, positive counts per unit of i, zero count per unit). */
const EXPONENTIAL = [
	{ attrs: { "rpc.method": "get" }, scale: 0, offset: 0, counts: [1, 2, 3], zero: 1, bounds: [1, 2, 4, 8] },
	// Correctly rounded 2^(k/2); JavaScript's 2 ** -0.5 is one ulp off.
	{
		attrs: { "rpc.method": "put" },
		scale: 1,
		offset: -1,
		counts: [1, 1],
		zero: 2,
		bounds: [Math.SQRT1_2, 1, Math.SQRT2],
	},
]

const insertOtelRows = (db: Chdb): void => {
	const sum = (temporality: number) => ({
		Flags: "0",
		AggregationTemporality: String(temporality),
		IsMonotonic: "true",
	})
	insertRows(db, "metrics_sum", [
		...Arr.flatMap(
			[
				["/a", 3],
				["/b", 5],
			] as const,
			([route, per]) =>
				Arr.map(TICKS, (i) => ({
					...otelRow("api.requests", "{request}", SHOP, { "http.route": route }, tick(i)),
					Value: String(per * i),
					...sum(2),
				})),
		),
		...Arr.map(TICKS, (i) => ({
			...otelRow("jobs.done", "", API, { queue: "q" }, tick(i)),
			Value: "2",
			...sum(1),
		})),
		// The same delta stream with a failed export between ticks 40 and 41.
		...Arr.map([...TICKS, 40.5], (i) => ({
			...otelRow("jobs.flaky", "", API, { queue: "q" }, tick(i)),
			Value: i === 40.5 ? "0" : "2",
			...sum(1),
			Flags: i === 40.5 ? "1" : "0",
		})),
	])
	insertRows(db, "metrics_gauge", [
		...Arr.map(TICKS, (i) => ({
			...otelRow("weird.gauge", "", API, {}, tick(i)),
			Value: sqlFloat(WEIRD[i % WEIRD.length] ?? 0),
			Flags: "0",
		})),
		...Arr.map([...FLAKY_TICKS, 40], (i) => ({
			...otelRow("flaky.gauge", "", API, {}, tick(i)),
			Value: String(i === 40 ? 0 : i),
			Flags: i === 40 ? "1" : "0",
		})),
	])
	insertRows(
		db,
		"metrics_exponential_histogram",
		Arr.flatMap(EXPONENTIAL, (h) =>
			Arr.map(TICKS, (i) => ({
				...otelRow("rpc.latency", "ms", API, h.attrs, tick(i)),
				Count: String(i * (h.zero + Arr.reduce(h.counts, 0, (a, b) => a + b))),
				Sum: String(10 * i),
				Scale: String(h.scale),
				ZeroCount: String(h.zero * i),
				PositiveOffset: String(h.offset),
				PositiveBucketCounts: `[${Arr.join(
					Arr.map(h.counts, (c) => String(c * i)),
					", ",
				)}]`,
				NegativeOffset: "0",
				NegativeBucketCounts: "[]",
				Flags: "0",
				AggregationTemporality: "2",
			})),
		),
	)
	const exponentialExport = (
		method: string,
		i: number,
		e: {
			scale: number
			offset: number
			counts: ReadonlyArray<number>
			flags: number
			temporality: number
		},
	): SqlRow => ({
		...otelRow("rpc.latency", "ms", API, { "rpc.method": method }, tick(i)),
		Count: String(Arr.reduce(e.counts, 0, (a, b) => a + b)),
		Sum: "1",
		Scale: String(e.scale),
		ZeroCount: "0",
		PositiveOffset: String(e.offset),
		PositiveBucketCounts: `[${Arr.join(Arr.map(e.counts, String), ", ")}]`,
		NegativeOffset: "0",
		NegativeBucketCounts: "[]",
		Flags: String(e.flags),
		AggregationTemporality: String(e.temporality),
	})
	insertRows(db, "metrics_exponential_histogram", [
		// Delta exports alternating one observation in (1, 2] at scale 0 and one in (4, 2^2.5] at scale 1.
		...Arr.map(TICKS, (i) =>
			exponentialExport("shift", i, {
				...(i % 2 === 0 ? { scale: 0, offset: 0 } : { scale: 1, offset: 4 }),
				counts: [1],
				flags: 0,
				temporality: 1,
			}),
		),
		// A cumulative series whose last export, at tick 40, is a stale marker with no buckets.
		...Arr.map(Arr.range(0, 40), (i) =>
			exponentialExport("flaky", i, {
				scale: 0,
				offset: 0,
				counts: i === 40 ? [] : [i, i],
				flags: i === 40 ? 1 : 0,
				temporality: 2,
			}),
		),
	]) // A classic histogram whose last export, at tick 40, is a stale marker with no buckets.
	insertRows(
		db,
		"metrics_histogram",
		Arr.map(Arr.range(0, 40), (i) => ({
			...otelRow("lat.classic", "s", API, {}, tick(i)),
			Count: String(i === 40 ? 0 : 3 * i),
			Sum: String(i),
			BucketCounts: i === 40 ? "[]" : `[${i}, ${i}, ${i}]`,
			ExplicitBounds: i === 40 ? "[]" : "[0.1, 1]",
			Flags: i === 40 ? "1" : "0",
			AggregationTemporality: "2",
		})),
	)
}

const series = (
	labels: Readonly<Record<string, string>>,
	value: (i: number) => number,
	ticks = TICKS,
): RawSeries => ({
	labels,
	samples: Arr.map(ticks, (i): readonly [number, number] => [tick(i), value(i)]),
})

/** The classic histogram an exponential one converts to: cumulative counts per `le`. */
const exponentialReference = (h: (typeof EXPONENTIAL)[number]): ReadonlyArray<RawSeries> => {
	const labels = { job: "api", rpc_method: h.attrs["rpc.method"] }
	const bounds = h.bounds
	const cumulative = Arr.drop(
		Arr.scan([h.zero, ...h.counts], 0, (a, b) => a + b),
		1,
	)
	const total = Arr.reduce([h.zero, ...h.counts], 0, (a, b) => a + b)
	return [
		...Arr.map(bounds, (le, k) =>
			series(
				{ __name__: "rpc_latency_milliseconds_bucket", ...labels, le: formatLe(le) },
				(i) => i * (cumulative[k] ?? 0),
			),
		),
		series({ __name__: "rpc_latency_milliseconds_bucket", ...labels, le: "+Inf" }, (i) => i * total),
		series({ __name__: "rpc_latency_milliseconds_count", ...labels }, (i) => i * total),
		series({ __name__: "rpc_latency_milliseconds_sum", ...labels }, (i) => 10 * i),
	]
}

/** What Prometheus would hold for the same data; delta sums as the deltas themselves. */
const otelReference = memorySource([
	series({ __name__: "api_requests_total", http_route: "/a", job: "shop/api" }, (i) => 3 * i),
	series({ __name__: "api_requests_total", http_route: "/b", job: "shop/api" }, (i) => 5 * i),
	series({ __name__: "jobs_done_total", queue: "q", job: "api" }, () => 2),
	series({ __name__: "weird_gauge", job: "api" }, (i) => WEIRD[i % WEIRD.length] ?? 0),
	...Arr.flatMap(EXPONENTIAL, exponentialReference),
])

/** The alternating delta histogram as cumulative counters at the coarse (scale 0) bounds. */
const shiftReference = memorySource(
	Arr.map(
		[
			["1.0", () => 0],
			["2.0", (i: number) => Math.floor(i / 2) + 1],
			["4.0", (i: number) => Math.floor(i / 2) + 1],
			["8.0", (i: number) => i + 1],
			["+Inf", (i: number) => i + 1],
		] as const,
		([le, value]) =>
			series(
				{ __name__: "rpc_latency_milliseconds_bucket", job: "api", rpc_method: "shift", le },
				value,
			),
	),
)

/** The delta sum as the running counter rate functions read it. */
const countersReference = memorySource([
	series({ __name__: "jobs_flaky_total", queue: "q", job: "api" }, (i) => 2 * (i + 1)),
	series({ __name__: "jobs_done_total", queue: "q", job: "api" }, (i) => 2 * (i + 1)),
])

describeWithChdb("PromQL on the warehouse matches the reference", () => {
	let root = ""
	let db: Chdb
	let catalog: ReadonlyArray<CatalogMetric> = []
	let otelCatalog: ReadonlyArray<CatalogMetric> = []
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
		insertOtelRows(db)
		const otel = CH.compileUnsafe(catalogQuery(), {
			orgId: OrgId.make(ORG_OTEL),
			startTime: Str.slice(0, 19)(chTime(START - HOUR_MS)),
			endTime: Str.slice(0, 19)(chTime(END + HOUR_MS)),
		})
		otelCatalog = catalogFromRows(decodeCatalog(db.query(normalizeSqlForClickHouseClient(otel.sql))))
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

	// Two cases keep the suite inside CI's budget: a range from before the data (window edges) and
	// an off-grid instant.
	const otelCases: ReadonlyArray<{ readonly name: string; readonly params: QueryParams }> = [
		{
			name: "range 45s from the data start",
			params: { startMs: T0 - 60_000, endMs: tick(79), stepMs: 45_000 },
		},
		{
			name: "instant off-grid",
			params: { startMs: tick(50) + 7_000, endMs: tick(50) + 7_000, stepMs: 0 },
		},
	]

	/** Both paths (pushdown and not) must equal the reference, and so each other. */
	const expectOtel = (query: string, want: string = query, source = otelReference, cases = otelCases) => {
		for (const { name, params } of cases) {
			const expected = runQuery(want, params, source)
			if (Result.isFailure(expected)) throw new Error(`${name} reference: ${expected.failure.message}`)
			for (const pushdown of [false, true]) {
				const label = `${query} ${name}${pushdown ? " pushdown" : ""}`
				const got = sqlRun(db, otelCatalog, query, params, pushdown, ORG_OTEL)
				if (Result.isFailure(got)) throw new Error(`${label}: ${got.failure}`)
				expect(`${label}: ${mismatch(got.success, expected.success) ?? "ok"}`).toBe(`${label}: ok`)
			}
		}
	}

	test("a quoted dotted attribute name is its underscore label on every path", () => {
		const routeA = '{"http.route"="/a"}'
		expectOtel(`api_requests_total${routeA}`, 'api_requests_total{http_route="/a"}')
		expectOtel(`rate(api_requests_total${routeA}[5m])`, 'rate(api_requests_total{http_route="/a"}[5m])')
		expectOtel(
			`rate(api_requests_total${routeA}[5m]) * 1`,
			'rate(api_requests_total{http_route="/a"}[5m])',
		)
		expectOtel(
			'sum by ("http.route") (rate(api_requests_total[5m]))',
			"sum by (http_route) (rate(api_requests_total[5m]))",
		)
		expectOtel('{"__name__"="api_requests_total", "service.name"="api"}', "api_requests_total")
	}, 120_000)

	test("service_name matches the service without its namespace", () => {
		expectOtel(
			'sum by (job) (api_requests_total{service_name="api"})',
			"sum by (job) (api_requests_total)",
		)
		expectOtel(
			'count(api_requests_total{service_name="shop/api"})',
			'count(api_requests_total{job="nobody"})',
		)
	}, 120_000)

	test("a delta sum is its deltas outside rate functions, so the query range does not change it", () => {
		expectOtel("jobs_done_total")
		expectOtel("max_over_time(jobs_done_total[1h])")
		expectOtel("rate(jobs_done_total[5m])", "rate(jobs_done_total[5m])", countersReference)
		expectOtel("increase(jobs_done_total[2m])", "increase(jobs_done_total[2m])", countersReference)
		// A stale marker in a delta stream does not restart the counter rate reads.
		expectOtel("rate(jobs_flaky_total[5m])", "rate(jobs_flaky_total[5m])", countersReference)
	}, 120_000)

	test("NaN and infinities are samples", () => {
		for (const query of [
			"weird_gauge",
			"max_over_time(weird_gauge[1m])",
			"min_over_time(weird_gauge[1m])",
			"changes(weird_gauge[5m])",
			"max(weird_gauge)",
		])
			expectOtel(query)
	}, 120_000)

	test("an exponential histogram has le buckets histogram_quantile reads", () => {
		for (const query of [
			'rpc_latency_milliseconds_bucket{rpc_method=~"get|put"}',
			'histogram_quantile(0.9, sum by (le) (rate(rpc_latency_milliseconds_bucket{rpc_method=~"get|put"}[5m])))',
		])
			expectOtel(query, query, otelReference)
		expectOtel(
			'count(rate({"rpc.latency_bucket", rpc_method="get"}[5m]))',
			'count(rate(rpc_latency_milliseconds_bucket{rpc_method="get"}[5m]))',
		)
	}, 120_000)

	test("exponential bounds stay complete when the scale and offset shift between delta exports", () => {
		const shift = 'rpc_latency_milliseconds_bucket{rpc_method="shift"}'
		expectOtel(`rate(${shift}[5m])`, `rate(${shift}[5m])`, shiftReference)
	}, 120_000)

	test("series discovery lists an exponential series' aligned bounds and filters le before the limit", () => {
		const matchers = [
			{ name: "__name__", op: "=" as const, value: "rpc_latency_milliseconds_bucket" },
			{ name: "rpc_method", op: "=" as const, value: "shift" },
			{ name: "le", op: "=" as const, value: "8.0" },
		]
		const window = { startMs: T0, endMs: tick(79) }
		const options = { orgId: OrgId.make(ORG_OTEL), limit: 1, maxNameFilter: 10, maxNameReads: 10 }
		const plans = buildSeriesLabelsQueries(matchers, window, otelCatalog, options)
		const decode = decodeJsonEachRow(promqlSeriesLabelsRowSchema)
		const found = toSeriesLabels(
			matchers,
			Arr.map(plans, (plan) => ({
				plan,
				rows: decode(db.query(sqlOf(Effect.runSync(plan.compiled)))),
			})),
		)
		expect(Arr.map(found, (labels) => labels.le)).toEqual(["8.0"])
	})

	test("a stale histogram export ends every bucket series, classic and exponential", () => {
		const count = (query: string, t: number, pushdown: boolean) => {
			const got = sqlRun(
				db,
				otelCatalog,
				query,
				{ startMs: t, endMs: t, stepMs: 0 },
				pushdown,
				ORG_OTEL,
			)
			if (Result.isFailure(got)) throw new Error(got.failure)
			return Arr.map(flatten(got.success), ([, , v]) => v)
		}
		const exponential = 'count(rpc_latency_milliseconds_bucket{rpc_method="flaky"})'
		const classic = "count(lat_classic_seconds_bucket)"
		for (const pushdown of [false, true]) {
			expect(count(exponential, tick(39) + 10_000, pushdown)).toEqual([4])
			expect(count(exponential, tick(41), pushdown)).toEqual([])
			expect(count(classic, tick(39) + 10_000, pushdown)).toEqual([3])
			expect(count(classic, tick(41), pushdown)).toEqual([])
		}
	}, 120_000)

	test("a no-recorded-value point ends the series instead of being looked back past", () => {
		const at = (query: string, t: number, pushdown: boolean) => {
			const got = sqlRun(
				db,
				otelCatalog,
				query,
				{ startMs: t, endMs: t, stepMs: 0 },
				pushdown,
				ORG_OTEL,
			)
			if (Result.isFailure(got)) throw new Error(got.failure)
			return Arr.map(flatten(got.success), ([, , v]) => v)
		}
		for (const pushdown of [false, true]) {
			expect(at("flaky_gauge", tick(39) + 10_000, pushdown)).toEqual([39])
			expect(at("flaky_gauge", tick(40), pushdown)).toEqual([])
			expect(at("flaky_gauge", tick(45), pushdown)).toEqual([])
			expect(at("flaky_gauge", tick(61), pushdown)).toEqual([61])
			// Range functions skip the marker, as Prometheus drops it from range vectors.
			expect(at("last_over_time(flaky_gauge[2m])", tick(45), pushdown)).toEqual([39])
			expect(at("count_over_time(flaky_gauge[1m])", tick(41), pushdown)).toEqual([2])
			const range = sqlRun(
				db,
				otelCatalog,
				"flaky_gauge",
				{ startMs: tick(36), endMs: tick(64), stepMs: 60_000 },
				pushdown,
				ORG_OTEL,
			)
			if (Result.isFailure(range)) throw new Error(range.failure)
			expect(Arr.map(flatten(range.success), ([, t]) => (t - T0) / 15_000)).toEqual([36, 60, 64])
		}
	}, 120_000)
})
