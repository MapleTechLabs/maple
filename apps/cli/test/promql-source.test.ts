// The PromQL selector source against a real ClickHouse engine (chDB).
//
// Each stored series is also kept as plain (time, value) samples, the way Prometheus would read
// it: delta sums accumulated, histogram buckets cumulative per bound. A small reference buckets
// those samples, and the query has to return the same bucket statistics, in bucketed and raw mode.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Array as Arr, Effect, Order, Record as Rec, String as Str } from "effect"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import * as CH from "@maple/query-engine/ch"
import {
	buildSelectorQueries,
	catalogFromRows,
	catalogQuery,
	promqlCatalogRowSchema,
	promqlSelectorRowSchema,
	toSelectorData,
	type CatalogMetric,
} from "@maple/query-engine/promql"
import type { SampleBucket, SeriesData } from "@maple/promql"
import { OrgId } from "@maple/domain"
import { describeWithChdb } from "./libchdb-test-support"

const SECOND_MS = 1_000
const MINUTE_MS = 60_000
/** On the hour, six hours ago, so every row lands in one catalog hour and inside the TTL. */
const BASE_MS = Math.floor(Date.now() / 3_600_000) * 3_600_000 - 6 * 3_600_000

const ORG_A = "org_promql_a"
const ORG_B = "org_promql_b"

type Sample = readonly [atMs: number, value: number]

/** `YYYY-MM-DD HH:MM:SS.fff` in UTC. */
const chTime = (offsetMs: number): string =>
	Str.replace("T", " ")(Str.slice(0, 23)(new Date(BASE_MS + offsetMs).toISOString()))

const quote = (value: string): string =>
	`'${Str.replaceAll("'", "\\'")(Str.replaceAll("\\", "\\\\")(value))}'`

const mapLiteral = (attributes: Readonly<Record<string, string>>): string =>
	`map(${Arr.join(
		Arr.flatMap(Rec.toEntries(attributes), ([key, value]) => [quote(key), quote(value)]),
		", ",
	)})`

const every = (fromMs: number, toMs: number, stepMs: number): ReadonlyArray<number> =>
	Arr.makeBy(Math.floor((toMs - fromMs) / stepMs) + 1, (i) => fromMs + i * stepMs)

interface SumSeries {
	readonly org: string
	readonly table: "metrics_sum" | "metrics_gauge"
	readonly metric: string
	readonly unit: string
	readonly attributes: Readonly<Record<string, string>>
	readonly resource: Readonly<Record<string, string>>
	readonly temporality: 1 | 2
	readonly samples: ReadonlyArray<Sample>
}

const insertValues = (db: Chdb, series: SumSeries): void => {
	const rows = Arr.map(
		series.samples,
		([atMs, value]) =>
			`(${quote(series.org)}, ${mapLiteral(series.resource)}, ${quote(series.resource["service.name"] ?? "unknown")}, ${quote(series.metric)}, ${quote(series.unit)}, ${mapLiteral(series.attributes)}, ${quote(chTime(START_MS))}, ${quote(chTime(atMs))}, ${value}${series.table === "metrics_sum" ? `, ${series.temporality}, true` : ""})`,
	)
	const extra = series.table === "metrics_sum" ? ", AggregationTemporality, IsMonotonic" : ""
	db.exec(
		`INSERT INTO ${series.table} (OrgId, ResourceAttributes, ServiceName, MetricName, MetricUnit, Attributes, StartTimeUnix, TimeUnix, Value${extra}) VALUES ${Arr.join(rows, ", ")}`,
	)
}

/** Every sample's StartTimeUnix: when the process began counting. */
const START_MS = -10 * MINUTE_MS

interface HistogramSeries {
	readonly org: string
	readonly metric: string
	readonly unit: string
	readonly attributes: Readonly<Record<string, string>>
	readonly resource: Readonly<Record<string, string>>
	readonly bounds: ReadonlyArray<number>
	/** Per export: bucket counts (one more than the bounds) and the sum, cumulative since START_MS. */
	readonly exports: ReadonlyArray<{
		readonly atMs: number
		readonly counts: ReadonlyArray<number>
		readonly sum: number
	}>
}

const insertHistogram = (db: Chdb, series: HistogramSeries): void => {
	const rows = Arr.map(
		series.exports,
		({ atMs, counts, sum }) =>
			`(${quote(series.org)}, ${mapLiteral(series.resource)}, ${quote(series.resource["service.name"] ?? "unknown")}, ${quote(series.metric)}, ${quote(series.unit)}, ${mapLiteral(series.attributes)}, ${quote(chTime(START_MS))}, ${quote(chTime(atMs))}, ${total(counts)}, ${sum}, [${Arr.join(Arr.map(counts, String), ", ")}], [${Arr.join(Arr.map(series.bounds, String), ", ")}], 2)`,
	)
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ResourceAttributes, ServiceName, MetricName, MetricUnit, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const RESOURCE = { "service.name": "api", "service.instance.id": "i1", "telemetry.sdk.name": "opentelemetry" }

// A counter that resets after its ninth export, a second route, a delta sum with gaps and a
// zero, a gauge with gaps, and a histogram; org B has the same counter with other values.
const counterA: SumSeries = {
	org: ORG_A,
	table: "metrics_sum",
	metric: "requests",
	unit: "{request}",
	attributes: { route: "/a" },
	resource: RESOURCE,
	temporality: 2,
	samples: Arr.map(every(-30 * SECOND_MS, 5 * MINUTE_MS, 15 * SECOND_MS), (t, k) => [
		t,
		k < 9 ? 10 * k : 4 * (k - 9) + 1,
	]),
}
const counterB: SumSeries = {
	...counterA,
	attributes: { route: "/b" },
	samples: Arr.map(every(-30 * SECOND_MS, 5 * MINUTE_MS, 15 * SECOND_MS), (t, k) => [t, 2 * k]),
}
const counterOrgB: SumSeries = {
	...counterA,
	org: ORG_B,
	samples: Arr.map(every(-30 * SECOND_MS, 5 * MINUTE_MS, 15 * SECOND_MS), (t, k) => [t, 1_000 + k]),
}
const DELTAS = [3, 0, 5, 2, 0, 7, 1, 4, 6, 2, 9, 3]
const deltaSum: SumSeries = {
	org: ORG_A,
	table: "metrics_sum",
	metric: "jobs.processed",
	unit: "",
	attributes: { queue: "emails" },
	resource: RESOURCE,
	temporality: 1,
	// Exports every 20 s, skipping 1:00-1:40.
	samples: Arr.map(
		Arr.filter(
			every(20 * SECOND_MS, 5 * MINUTE_MS, 20 * SECOND_MS),
			(t) => t < MINUTE_MS || t > 100 * SECOND_MS,
		),
		(t, i) => [t, DELTAS[i % DELTAS.length] ?? 0],
	),
}
const gauge: SumSeries = {
	org: ORG_A,
	table: "metrics_gauge",
	metric: "queue.depth",
	unit: "",
	attributes: { "queue.name": "emails" },
	resource: RESOURCE,
	temporality: 2,
	// Every 10 s with two gaps; the last reading lands exactly on the end of the range.
	samples: Arr.map(
		Arr.filter(
			every(0, 5 * MINUTE_MS, 10 * SECOND_MS),
			(t) => !(t > 50 * SECOND_MS && t < 2 * MINUTE_MS) && t !== 4 * MINUTE_MS,
		),
		(t, i) => [t, ((i * 7) % 11) - 3],
	),
}
const histogram: HistogramSeries = {
	org: ORG_A,
	metric: "http.server.request.duration",
	unit: "s",
	attributes: { "http.route": "/checkout" },
	resource: RESOURCE,
	bounds: [0.1, 0.5, 1],
	exports: Arr.map(every(-30 * SECOND_MS, 5 * MINUTE_MS, 30 * SECOND_MS), (atMs, i) => ({
		atMs,
		counts: [i, 2 * i, 3 * i, i + (i > 4 ? 1 : 0)],
		sum: 7 * i,
	})),
}

interface Request {
	readonly metricName: string | undefined
	readonly matchers: ReadonlyArray<{
		readonly name: string
		readonly op: "=" | "!=" | "=~" | "!~"
		readonly value: string
	}>
	readonly startMs: number
	readonly endMs: number
	readonly originMs: number
	readonly widthMs: number
	readonly needsValues: boolean
}

type Matcher = Request["matchers"][number]

const request = (
	name: string,
	matchers: ReadonlyArray<Matcher> = [],
	overrides: Partial<Request> = {},
): Request => ({
	metricName: name,
	matchers: [{ name: "__name__", op: "=", value: name }, ...matchers],
	startMs: BASE_MS,
	endMs: BASE_MS + 5 * MINUTE_MS,
	originMs: BASE_MS,
	widthMs: MINUTE_MS,
	needsValues: false,
	...overrides,
})

const total = (values: ReadonlyArray<number>): number => Arr.reduce(values, 0, (a, b) => a + b)

type BucketStats = Readonly<Record<string, number | ReadonlyArray<number> | undefined>>

/** The documented bucket statistics of one series' samples (offsets from BASE_MS). */
const reference = (samples: ReadonlyArray<Sample>, req: Request): ReadonlyArray<BucketStats> => {
	const inRange = Arr.filter(
		Arr.map(samples, ([t, v]) => [BASE_MS + t, v] as const),
		([t]) => t > req.startMs && t <= req.endMs,
	)
	const endOf = (t: number) =>
		req.widthMs === 0 ? t : req.originMs + Math.ceil((t - req.originMs) / req.widthMs) * req.widthMs
	const groups = Arr.groupBy(inRange, ([t]) => String(endOf(t)))
	return Arr.map(Rec.toEntries(groups), ([end, group]) => {
		const values = Arr.map(group, ([, v]) => v)
		const pairs = Arr.zip(Arr.dropRight(values, 1), Arr.drop(values, 1))
		const xs = Arr.map(group, ([t]) => (t - req.startMs) / 1000)
		const first = Arr.headNonEmpty(group)
		const last = Arr.lastNonEmpty(group)
		const prev = group[group.length - 2] ?? last
		const stats = {
			end: Number(end),
			firstT: first[0],
			firstV: first[1],
			lastT: last[0],
			lastV: last[1],
			prevT: prev[0],
			prevV: prev[1],
			count: group.length,
			sum: total(values),
			min: Math.min(...values),
			max: Math.max(...values),
			sumSquares: total(Arr.map(values, (v) => v * v)),
			increase: total(Arr.map(pairs, ([p, v]) => (v < p ? v : v - p))),
			resets: Arr.filter(pairs, ([p, v]) => v < p).length,
			changes: Arr.filter(pairs, ([p, v]) => v !== p).length,
			sumT: total(xs),
			sumTT: total(Arr.map(xs, (x) => x * x)),
			sumTV: total(Arr.map(Arr.zip(xs, values), ([x, v]) => x * v)),
		}
		return req.needsValues ? { ...stats, values } : stats
	})
}

/** Running totals of delta samples, from the first one in the range. */
const accumulate = (samples: ReadonlyArray<Sample>, startMs: number): ReadonlyArray<Sample> => {
	const inRange = Arr.filter(samples, ([t]) => BASE_MS + t > startMs)
	const totals = Arr.scan(
		Arr.map(inRange, ([, v]) => v),
		0,
		(a, b) => a + b,
	)
	return Arr.zipWith(inRange, Arr.drop(totals, 1), ([t], sum) => [t, sum] as const)
}

/** Rounded so sums taken in another order compare equal. */
const roundNumber = (value: number): number => Number(value.toPrecision(12))

const roundStats = (stats: BucketStats): BucketStats =>
	Rec.map(stats, (value) =>
		typeof value === "number"
			? roundNumber(value)
			: value === undefined
				? value
				: Arr.map(value, roundNumber),
	)

interface SeriesStats {
	readonly labels: Readonly<Record<string, string>>
	readonly buckets: ReadonlyArray<BucketStats>
}

/** A source bucket as the plain record the reference produces. */
const statsOf = (b: SampleBucket): BucketStats => ({
	end: b.end,
	firstT: b.firstT,
	firstV: b.firstV,
	lastT: b.lastT,
	lastV: b.lastV,
	prevT: b.prevT,
	prevV: b.prevV,
	count: b.count,
	sum: b.sum,
	min: b.min,
	max: b.max,
	sumSquares: b.sumSquares,
	increase: b.increase,
	resets: b.resets,
	changes: b.changes,
	sumT: b.sumT,
	sumTT: b.sumTT,
	sumTV: b.sumTV,
	values: b.values,
})

/** The source's series in the reference's shape. */
const asStats = (series: ReadonlyArray<SeriesData>): ReadonlyArray<SeriesStats> =>
	Arr.map(series, (s) => ({ labels: s.labels, buckets: Arr.map(s.buckets, statsOf) }))

const normalized = (series: ReadonlyArray<SeriesStats>): ReadonlyArray<SeriesStats> =>
	Arr.sort(
		Arr.map(series, (s) => ({ labels: s.labels, buckets: Arr.map(s.buckets, roundStats) })),
		Order.mapInput(Order.String, (s: SeriesStats) => JSON.stringify(s.labels)),
	)

interface ExpectedSeries {
	readonly labels: Readonly<Record<string, string>>
	readonly samples: ReadonlyArray<Sample>
}

const expected = (req: Request, series: ReadonlyArray<ExpectedSeries>) =>
	normalized(
		Arr.filter(
			Arr.map(series, (s) => ({ labels: s.labels, buckets: reference(s.samples, req) })),
			(s) => s.buckets.length > 0,
		),
	)

const decodeRows = decodeJsonEachRow(promqlSelectorRowSchema)
const decodeCatalog = decodeJsonEachRow(promqlCatalogRowSchema)

const catalogOf = (db: Chdb, org: string): ReadonlyArray<CatalogMetric> => {
	const compiled = CH.compileUnsafe(catalogQuery(), {
		orgId: OrgId.make(org),
		startTime: Str.slice(0, 19)(chTime(-HOUR_MS)),
		endTime: Str.slice(0, 19)(chTime(HOUR_MS)),
	})
	return catalogFromRows(decodeCatalog(db.query(normalizeSqlForClickHouseClient(compiled.sql))))
}

const fetchRows = (db: Chdb, org: string, req: Request, maxSeries = 100) =>
	Arr.map(buildSelectorQueries(req, catalogOf(db, org), { orgId: OrgId.make(org), maxSeries }), (plan) => ({
		plan,
		rows: decodeRows(db.query(normalizeSqlForClickHouseClient(Effect.runSync(plan.compiled).sql))),
	}))

const select = (db: Chdb, org: string, req: Request, maxSeries = 100) =>
	toSelectorData(req, fetchRows(db, org, req, maxSeries))

/** Series the SQL itself returned, before the final matcher check. */
const sqlSeriesCount = (db: Chdb, org: string, req: Request) =>
	total(Arr.map(fetchRows(db, org, req), ({ rows }) => rows.length))

const selected = (db: Chdb, org: string, req: Request) => normalized(asStats(select(db, org, req).series))

const HOUR_MS = 60 * MINUTE_MS

const labels = (name: string, extra: Readonly<Record<string, string>>) => ({
	__name__: name,
	job: "api",
	instance: "i1",
	...extra,
})

const bucketSeries = (le: string, index: number): ExpectedSeries => ({
	labels: labels("http_server_request_duration_seconds_bucket", { http_route: "/checkout", le }),
	samples: Arr.map(histogram.exports, ({ atMs, counts }) => [atMs, total(Arr.take(counts, index + 1))]),
})

describeWithChdb("PromQL selector source", () => {
	let root = ""
	let db: Chdb

	beforeAll(() => {
		root = mkdtempSync(join(tmpdir(), "maple-promql-source-"))
		db = Chdb.open({ dataDir: join(root, "data"), schemaSql })
		for (const series of [counterA, counterB, counterOrgB, deltaSum, gauge]) insertValues(db, series)
		insertHistogram(db, histogram)
	})

	afterAll(() => {
		db.close()
		rmSync(root, { recursive: true, force: true })
	})

	const counters = [
		{ labels: labels("requests_total", { route: "/a" }), samples: counterA.samples },
		{ labels: labels("requests_total", { route: "/b" }), samples: counterB.samples },
	]

	test("a counter with a reset, bucketed by minute", () => {
		const req = request("requests_total")
		const data = select(db, ORG_A, req)
		expect(normalized(asStats(data.series))).toEqual(expected(req, counters))
		// The reset at 1:45 (80 to 1) is one reset in the second minute: 70 to 80, then 1, then 1 to 5.
		const routeA = Arr.filter(data.series, (s) => s.labels.route === "/a")
		expect(
			Arr.flatMap(routeA, (s) =>
				Arr.map(s.buckets, (b) => [b.end - BASE_MS, b.count, b.resets, b.increase]),
			),
		).toEqual([
			[MINUTE_MS, 4, 0, 30],
			[2 * MINUTE_MS, 4, 1, 10 + 1 + 4],
			[3 * MINUTE_MS, 4, 0, 12],
			[4 * MINUTE_MS, 4, 0, 12],
			[5 * MINUTE_MS, 4, 0, 12],
		])
	})

	test("a counter on an unaligned grid, and raw with values", () => {
		const unaligned = request("requests_total", [], {
			originMs: BASE_MS + 7 * SECOND_MS,
			widthMs: 45 * SECOND_MS,
		})
		expect(selected(db, ORG_A, unaligned)).toEqual(expected(unaligned, counters))
		const raw = request("requests_total", [], { widthMs: 0, needsValues: true })
		expect(selected(db, ORG_A, raw)).toEqual(expected(raw, counters))
	})

	test("label matchers run in the query with Prometheus semantics", () => {
		const cases: ReadonlyArray<readonly [ReadonlyArray<Matcher>, ReadonlyArray<ExpectedSeries>]> = [
			[[{ name: "route", op: "=", value: "/a" }], [counters[0]!]],
			[[{ name: "route", op: "!=", value: "/a" }], [counters[1]!]],
			[[{ name: "route", op: "=~", value: "/b|/c" }], [counters[1]!]],
			[[{ name: "route", op: "=~", value: "/" }], []],
			[[{ name: "route", op: "!~", value: "/a" }], [counters[1]!]],
			[
				[
					{ name: "job", op: "=", value: "api" },
					{ name: "instance", op: "=~", value: "i." },
				],
				counters,
			],
			[[{ name: "missing", op: "=", value: "" }], counters],
			[[{ name: "telemetry_sdk_name", op: "=", value: "opentelemetry" }], []],
		]
		for (const [matchers, series] of cases) {
			const req = request("requests_total", matchers)
			expect(selected(db, ORG_A, req)).toEqual(expected(req, series))
			expect(sqlSeriesCount(db, ORG_A, req)).toBe(series.length)
		}
	})

	test("another org's rows never appear", () => {
		const req = request("requests_total", [], { widthMs: 0 })
		const orgA = Arr.flatMap(select(db, ORG_A, req).series, (s) => Arr.map(s.buckets, (b) => b.lastV))
		expect(Arr.every(orgA, (v) => v < 1_000)).toBe(true)
		const orgB = select(db, ORG_B, req)
		expect(normalized(asStats(orgB.series))).toEqual(
			expected(req, [
				{ labels: labels("requests_total", { route: "/a" }), samples: counterOrgB.samples },
			]),
		)
	})

	test("a delta sum reads as a running counter", () => {
		const expectedSeries = (req: Request) => [
			{
				labels: labels("jobs_processed_total", { queue: "emails" }),
				samples: accumulate(deltaSum.samples, req.startMs),
			},
		]
		for (const req of [
			request("jobs_processed_total", [], { originMs: BASE_MS + 7 * SECOND_MS }),
			request("jobs_processed_total", [], { widthMs: 0, needsValues: true }),
			request("jobs_processed_total", [], { startMs: BASE_MS + 90 * SECOND_MS }),
		]) {
			expect(selected(db, ORG_A, req)).toEqual(expected(req, expectedSeries(req)))
		}
	})

	test("a gauge with gaps, and the range end is inclusive", () => {
		const series = [{ labels: labels("queue_depth", { queue_name: "emails" }), samples: gauge.samples }]
		// `queue_name` matches the stored key `queue.name` through the normalized-key fallback.
		const byName: Matcher = { name: "queue_name", op: "=", value: "emails" }
		for (const req of [
			request("queue_depth", [byName], { widthMs: 45 * SECOND_MS }),
			request("queue_depth", [], { widthMs: 0, needsValues: true }),
		]) {
			expect(selected(db, ORG_A, req)).toEqual(expected(req, series))
		}
		const other = request("queue_depth", [{ name: "queue_name", op: "=", value: "sms" }])
		expect(sqlSeriesCount(db, ORG_A, other)).toBe(0)
		expect(sqlSeriesCount(db, ORG_A, request("queue_depth", [byName]))).toBe(1)
	})

	test("an explicit histogram's buckets, count and sum", () => {
		const buckets = request("http_server_request_duration_seconds_bucket")
		expect(selected(db, ORG_A, buckets)).toEqual(
			expected(buckets, [
				bucketSeries("0.1", 0),
				bucketSeries("0.5", 1),
				bucketSeries("1.0", 2),
				bucketSeries("+Inf", 3),
			]),
		)
		const inf = request(
			"http_server_request_duration_seconds_bucket",
			[{ name: "le", op: "=", value: "+Inf" }],
			{ widthMs: 0 },
		)
		expect(selected(db, ORG_A, inf)).toEqual(expected(inf, [bucketSeries("+Inf", 3)]))
		const count = request("http_server_request_duration_seconds_count")
		expect(selected(db, ORG_A, count)).toEqual(
			expected(count, [
				{
					labels: labels("http_server_request_duration_seconds_count", { http_route: "/checkout" }),
					samples: Arr.map(histogram.exports, ({ atMs, counts }) => [atMs, total(counts)]),
				},
			]),
		)
		const sum = request("http_server_request_duration_seconds_sum", [], { widthMs: 0 })
		expect(selected(db, ORG_A, sum)).toEqual(
			expected(sum, [
				{
					labels: labels("http_server_request_duration_seconds_sum", { http_route: "/checkout" }),
					samples: Arr.map(histogram.exports, ({ atMs, sum }) => [atMs, sum]),
				},
			]),
		)
	})

	test("a query returns one series past the cap so overflow shows", () => {
		expect(select(db, ORG_A, request("requests_total"), 1).series).toHaveLength(2)
	})

	test("a deploy that changes service.version keeps one series", () => {
		// Inside the request window (BASE, BASE + 5m]; the start is exclusive.
		const samples = Arr.map(every(15 * SECOND_MS, 5 * MINUTE_MS, 15 * SECOND_MS), (t, k): Sample => [
			t,
			3 * k,
		])
		const half = Math.floor(samples.length / 2)
		const deployed = (version: string, part: ReadonlyArray<Sample>): SumSeries => ({
			...counterA,
			metric: "deploys",
			resource: { ...RESOURCE, "service.version": version, "telemetry.sdk.version": version },
			samples: part,
		})
		insertValues(db, deployed("1.0", Arr.take(samples, half)))
		insertValues(db, deployed("2.0", Arr.drop(samples, half)))
		const series = select(db, ORG_A, request("deploys_total")).series
		expect(series).toHaveLength(1)
		expect(total(Arr.flatMap(series, (s) => Arr.map(s.buckets, (b) => b.count)))).toBe(samples.length)
	})
})
