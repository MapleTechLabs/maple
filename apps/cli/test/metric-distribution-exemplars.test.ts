// A histogram's distribution (the heatmap's cells) and a metric's exemplars against a real
// ClickHouse engine (chDB). The distribution is checked against the observations each export
// added, bucketed by hand; the exemplars against the highest values per time bucket.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { decodeJsonEachRow } from "@maple/local-server/chdb-rows"
import * as CH from "@maple/query-engine/ch"
import { normalizeSqlForClickHouseClient } from "@maple/query-engine/execution"
import { Array as Arr, Order, Schema, String as Str } from "effect"
import { describeWithChdb } from "./libchdb-test-support"
import {
	BASE_MS,
	bucketCounts,
	chTimestamp,
	type ExponentialSeries,
	exponentialIndex,
	type ExportedSeries,
	type HistogramSeries,
	increaseAt,
	insertExponentialHistograms,
	insertHistograms,
	MINUTE_MS,
	type Observation,
	SECOND_MS,
	ticksOf,
} from "./histogram-metrics-support"

const METRIC = "http.server.request.duration"
const at = (seconds: number, value: number): Observation => ({ atMs: seconds * SECOND_MS, value })

const base: Omit<ExportedSeries, "org" | "observations"> = {
	metric: METRIC,
	service: "api",
	attributes: {},
	temporality: "delta",
	intervalMs: 10 * SECOND_MS,
	firstTickMs: -10 * SECOND_MS,
	lastTickMs: 5 * MINUTE_MS,
	recordExtrema: true,
}

const explicit = (
	org: string,
	overrides: Partial<HistogramSeries> & Pick<HistogramSeries, "observations">,
): HistogramSeries => ({ ...base, org, bounds: [10, 20, 50], ...overrides })

const exponential = (
	org: string,
	overrides: Partial<ExponentialSeries> & Pick<ExponentialSeries, "observations">,
): ExponentialSeries => ({ ...base, org, maxScale: 0, maxSize: 160, ...overrides })

// Spread over three minutes, so the distribution has more than one column.
const SPREAD: ReadonlyArray<Observation> = [
	at(1, 5),
	at(2, 15),
	at(11, 15),
	at(21, 30),
	at(42, 100),
	at(65, 5),
	at(66, 5),
	at(70, 60),
	at(125, 12),
]

const EXPLICIT_WORLD: ReadonlyArray<HistogramSeries> = [
	explicit("org_delta", { observations: SPREAD }),
	explicit("org_cumulative", { observations: SPREAD, temporality: "cumulative" }),
	explicit("org_restart", {
		observations: SPREAD,
		temporality: "cumulative",
		restartsAtMs: [25 * SECOND_MS],
	}),
	// Two services with different layouts: a bucket's lower edge is the nearest bound below it.
	explicit("org_mixed", { observations: [at(5, 4), at(6, 12), at(7, 18)], bounds: [10, 20] }),
	explicit("org_mixed", {
		observations: [at(5, 14), at(6, 16), at(7, 40)],
		bounds: [15],
		service: "worker",
	}),
]

const SIGNED: ReadonlyArray<Observation> = Arr.map([-24, -12, -6, 0, 0, 3, 3, 6, 40], (value, i) =>
	at(i + 1, value),
)

const EXPONENTIAL_WORLD: ReadonlyArray<ExponentialSeries> = [
	exponential("org_exp_delta", { observations: SPREAD }),
	exponential("org_exp_cumulative", { observations: SPREAD, temporality: "cumulative" }),
	exponential("org_exp_signed", { observations: SIGNED }),
	// Quarter-power buckets coarsen to whole powers of two.
	exponential("org_exp_fine", { observations: [at(5, 2.5), at(6, 3.5), at(7, 5), at(8, 11)], maxScale: 2 }),
]

/** One heatmap cell: time bucket offset, value range, observations. `null` is an open edge. */
type Cell = readonly [number, number | null, number | null, number]

const byCell: Order.Order<Cell> = Order.combine(
	Order.combine(
		Order.mapInput(Order.Number, (c: Cell) => c[0]),
		Order.mapInput(Order.Number, (c: Cell) => c[2] ?? Number.POSITIVE_INFINITY),
	),
	Order.mapInput(Order.Number, (c: Cell) => c[1] ?? Number.NEGATIVE_INFINITY),
)

const DistributionRow = Schema.Struct({
	bucket: Schema.String,
	lowerBound: Schema.NullOr(CH.CHNumber),
	upperBound: Schema.NullOr(CH.CHNumber),
	count: CH.CHNumber,
})
const decodeDistribution = decodeJsonEachRow(DistributionRow)

const offsetOf = (bucket: string): number => Date.parse(`${Str.replace(" ", "T")(bucket)}Z`) - BASE_MS

const window = (fromMs: number, toMs: number) => ({
	startTime: Str.slice(0, 19)(chTimestamp(fromMs)),
	endTime: Str.slice(0, 19)(chTimestamp(toMs)),
})

/** What an export at `tick` lands in: its time bucket, by the bucket width. */
const bucketOf = (tickMs: number, widthMs: number) =>
	Math.floor((BASE_MS + tickMs) / widthMs) * widthMs - BASE_MS

/** Every export in [fromMs, toMs] with the observations it added. */
const exportsIn = <S extends ExportedSeries>(series: ReadonlyArray<S>, fromMs: number, toMs: number) =>
	Arr.flatMap(series, (s) =>
		Arr.map(
			Arr.filter(ticksOf(s), (tick) => tick >= fromMs && tick <= toMs),
			(tick) => ({ series: s, tick, values: increaseAt(s, tick) }),
		),
	)

const sumCells = (cells: ReadonlyArray<Cell>): ReadonlyArray<Cell> => {
	const totals = new Map<string, Cell>()
	for (const cell of cells) {
		const key = `${cell[0]}|${cell[1]}|${cell[2]}`
		const seen = totals.get(key)
		totals.set(key, seen === undefined ? cell : [cell[0], cell[1], cell[2], seen[3] + cell[3]])
	}
	return Arr.sort(
		Arr.filter([...totals.values()], (c) => c[3] > 0),
		byCell,
	)
}

/** The explicit reference: each export's bucket counts under its own layout's edges. */
const explicitReference = (
	world: ReadonlyArray<HistogramSeries>,
	fromMs: number,
	toMs: number,
	widthMs: number,
): ReadonlyArray<Cell> =>
	sumCells(
		Arr.flatMap(exportsIn(world, fromMs, toMs), ({ series, tick, values }) =>
			Arr.map(bucketCounts(series.bounds, values), (count, i): Cell => [
				bucketOf(tick, widthMs),
				series.bounds[i - 1] ?? null,
				series.bounds[i] ?? null,
				count,
			]),
		),
	)

/** The exponential reference: each observation in its power-of-two bucket. */
const exponentialReference = (
	world: ReadonlyArray<ExponentialSeries>,
	fromMs: number,
	toMs: number,
	widthMs: number,
): ReadonlyArray<Cell> =>
	sumCells(
		Arr.flatMap(exportsIn(world, fromMs, toMs), ({ tick, values }) =>
			Arr.map(values, (v): Cell => {
				const bucket = bucketOf(tick, widthMs)
				if (v === 0) return [bucket, 0, 0, 1]
				const k = exponentialIndex(Math.abs(v), 0)
				return v > 0 ? [bucket, 2 ** k, 2 ** (k + 1), 1] : [bucket, -(2 ** (k + 1)), -(2 ** k), 1]
			}),
		),
	)

const EXEMPLAR_ORG = "org_exemplars"

/** Histogram rows carrying exemplars: [offset, service, route, [value, traceId][]]. */
const EXEMPLAR_ROWS: ReadonlyArray<
	readonly [number, string, string, ReadonlyArray<readonly [number, string]>, string?]
> = [
	[
		10 * SECOND_MS,
		"api",
		"/a",
		[
			[5, "t-five"],
			[50, "t-fifty"],
		],
	],
	[
		20 * SECOND_MS,
		"api",
		"/a",
		[
			[500, "t-five-hundred"],
			[20, "t-twenty"],
			// Not linked to a trace: never returned.
			[9_000, ""],
		],
	],
	[30 * SECOND_MS, "api", "/b", [[1_000, "t-thousand"]]],
	[70 * SECOND_MS, "api", "/a", [[7, "t-seven"]]],
	// Another org's exemplar never leaks in.
	[15 * SECOND_MS, "api", "/a", [[99_999, "t-other-org"]], "org_other"],
]

const quote = (value: string) => `'${value}'`

const insertExemplarRows = (db: Chdb) => {
	const rows = Arr.map(EXEMPLAR_ROWS, ([offset, service, route, exemplars, org]) => {
		const ts = quote(chTimestamp(offset))
		const list = <A>(f: (e: readonly [number, string]) => A) =>
			`[${Arr.join(
				Arr.map(exemplars, (e) => String(f(e))),
				", ",
			)}]`
		return `(${quote(org ?? EXEMPLAR_ORG)}, ${quote(service)}, ${quote(METRIC)}, map('http.route', ${quote(route)}), ${ts}, ${ts}, 1, 1, [1], [], ${list(([, id]) => quote(id))}, ${list(([, id]) => quote(id === "" ? "" : `${id}-span`))}, ${list(() => ts)}, ${list(([value]) => value)}, 1)`
	})
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, Attributes, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, ExemplarsTraceId, ExemplarsSpanId, ExemplarsTimestamp, ExemplarsValue, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const RECORDED_ORG = "org_exemplars_recorded"

/** Datapoints whose exemplars were recorded before the export: [export offset, [value, trace, recorded offset][]]. */
const RECORDED_ROWS: ReadonlyArray<readonly [number, ReadonlyArray<readonly [number, string, number]>]> = [
	// Recorded at 0:45, exported at 1:00.5: the heatmap counts it in the 1:00 bucket.
	[
		60_500,
		[
			[3, "t-late", 45 * SECOND_MS],
			[0.5, "t-low", 50 * SECOND_MS],
			[0.2, "t-lower", 51 * SECOND_MS],
			[0.1, "t-lowest", 52 * SECOND_MS],
		],
	],
	// A cumulative reservoir carries t-late forward on the next export, beside a new observation
	// from the same span.
	[
		120_500,
		[
			[3, "t-late", 45 * SECOND_MS],
			[0.7, "t-late", 110 * SECOND_MS],
		],
	],
	[180_500, [[3, "t-late", 45 * SECOND_MS]]],
]

const insertRecordedRows = (db: Chdb) => {
	const rows = Arr.map(RECORDED_ROWS, ([offset, exemplars]) => {
		const ts = quote(chTimestamp(offset))
		const list = (f: (e: readonly [number, string, number]) => string) =>
			`[${Arr.join(Arr.map(exemplars, f), ", ")}]`
		return `(${quote(RECORDED_ORG)}, 'api', ${quote(METRIC)}, ${ts}, ${ts}, 1, 1, [1], [], ${list(([, id]) => quote(id))}, ${list(([, id]) => quote(`${id}-span`))}, ${list(([, , at]) => quote(chTimestamp(at)))}, ${list(([value]) => String(value))}, 1)`
	})
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, ExemplarsTraceId, ExemplarsSpanId, ExemplarsTimestamp, ExemplarsValue, AggregationTemporality) VALUES ${Arr.join(rows, ", ")}`,
	)
}

const SIGNED_ORG = "org_exemplars_signed"

/** One exponential datapoint at 0:10 whose exemplar sits exactly on a negative bucket edge (-4). */
const insertSignedExemplar = (db: Chdb) => {
	const ts = quote(chTimestamp(10 * SECOND_MS))
	db.exec(
		`INSERT INTO metrics_exponential_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, Scale, ZeroCount, PositiveOffset, PositiveBucketCounts, NegativeOffset, NegativeBucketCounts, ExemplarsTraceId, ExemplarsSpanId, ExemplarsTimestamp, ExemplarsValue, AggregationTemporality) VALUES (${quote(SIGNED_ORG)}, 'api', ${quote(METRIC)}, ${ts}, ${ts}, 1, -4, 0, 0, 0, [], 1, [1], ['t-edge'], ['t-edge-span'], [${ts}], [-4], 1)`,
	)
}

const BUCKETLESS_ORG = "org_bucketless"

/** A point OTLP allows: four observations and no buckets, beside one with its buckets. */
const insertBucketless = (db: Chdb) => {
	const ts = quote(chTimestamp(10 * SECOND_MS))
	db.exec(
		`INSERT INTO metrics_histogram (OrgId, ServiceName, MetricName, StartTimeUnix, TimeUnix, Count, Sum, BucketCounts, ExplicitBounds, AggregationTemporality) VALUES (${quote(BUCKETLESS_ORG)}, 'api', ${quote(METRIC)}, ${ts}, ${ts}, 4, 40, [], [], 1), (${quote(BUCKETLESS_ORG)}, 'worker', ${quote(METRIC)}, ${ts}, ${ts}, 2, 30, [1, 1], [10], 1)`,
	)
}

const ExemplarRow = Schema.Struct({
	bucket: Schema.String,
	timestamp: Schema.String,
	value: CH.CHNumber,
	traceId: Schema.String,
	spanId: Schema.String,
	serviceName: Schema.String,
})
const decodeExemplars = decodeJsonEachRow(ExemplarRow)

describeWithChdb("histogram distribution and exemplars", () => {
	let dir: string
	let db: Chdb

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "maple-distribution-"))
		db = Chdb.open({ dataDir: dir, schemaSql })
		insertHistograms(db, EXPLICIT_WORLD)
		insertExponentialHistograms(db, EXPONENTIAL_WORLD)
		insertExemplarRows(db)
		insertRecordedRows(db)
		insertSignedExemplar(db)
		insertBucketless(db)
	})

	afterAll(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})

	const distribution = (
		org: string,
		opts: Partial<CH.MetricsFilterOpts> & Pick<CH.MetricsFilterOpts, "metricType">,
		bucketSeconds = 60,
		fromMs = 0,
		toMs = 5 * MINUTE_MS,
	): ReadonlyArray<Cell> => {
		const compiled = CH.compileUnsafe(CH.histogramDistributionQuery(opts), {
			orgId: org,
			metricName: METRIC,
			bucketSeconds,
			...window(fromMs, toMs),
		})
		return Arr.sort(
			Arr.map(
				decodeDistribution(db.query(normalizeSqlForClickHouseClient(compiled.sql))),
				(row): Cell => [offsetOf(row.bucket), row.lowerBound, row.upperBound, row.count],
			),
			byCell,
		)
	}

	const exemplars = (
		opts: Partial<CH.MetricExemplarsOpts> = {},
		bucketSeconds = 60,
		org = EXEMPLAR_ORG,
		extra: Readonly<Record<string, string>> = {},
	) => {
		const compiled = CH.compileUnsafe(CH.metricExemplarsQuery({ metricType: "histogram", ...opts }), {
			orgId: org,
			metricName: METRIC,
			bucketSeconds,
			...window(0, 5 * MINUTE_MS),
			...extra,
		})
		return decodeExemplars(db.query(normalizeSqlForClickHouseClient(compiled.sql)))
	}

	const CH_EXEMPLARS = (database: Chdb, opts: CH.MetricExemplarsOpts) =>
		decodeExemplars(
			database.query(
				normalizeSqlForClickHouseClient(
					CH.compileUnsafe(CH.metricExemplarsQuery(opts), {
						orgId: SIGNED_ORG,
						metricName: METRIC,
						bucketSeconds: 60,
						cellBucket: Str.slice(0, 19)(chTimestamp(0)),
						...window(0, 5 * MINUTE_MS),
					}).sql,
				),
			),
		)

	test("each explicit cell counts the observations exported into it, however they were exported", () => {
		for (const bucketSeconds of [60, 120]) {
			const width = bucketSeconds * SECOND_MS
			const expected = explicitReference(
				Arr.filter(EXPLICIT_WORLD, (s) => s.org === "org_delta"),
				0,
				5 * MINUTE_MS,
				width,
			)
			expect(expected.length).toBeGreaterThan(3)
			expect(distribution("org_delta", { metricType: "histogram" }, bucketSeconds)).toEqual(expected)
			expect(distribution("org_cumulative", { metricType: "histogram" }, bucketSeconds)).toEqual(
				expected,
			)
		}
	})

	test("a restart loses what was never exported, and nothing else", () => {
		const restarted = Arr.filter(EXPLICIT_WORLD, (s) => s.org === "org_restart")
		expect(distribution("org_restart", { metricType: "histogram" })).toEqual(
			explicitReference(restarted, 0, 5 * MINUTE_MS, MINUTE_MS),
		)
	})

	test("series with different bucket layouts keep their own edges, so no count moves to a narrower range", () => {
		const mixed = Arr.filter(EXPLICIT_WORLD, (s) => s.org === "org_mixed")
		expect(distribution("org_mixed", { metricType: "histogram" })).toEqual(
			explicitReference(mixed, 0, 5 * MINUTE_MS, MINUTE_MS),
		)
		// api's 12 and 18 stay in api's (10, 20]; nothing is counted in a (15, 20] neither layout has.
		expect(
			Arr.filter(
				distribution("org_mixed", { metricType: "histogram" }),
				(c) => c[1] === 15 && c[2] === 20,
			),
		).toEqual([])
		// The worker alone: its single bound splits the minute in two.
		expect(distribution("org_mixed", { metricType: "histogram", serviceName: "worker" })).toEqual([
			[0, null, 15, 1],
			[0, 15, null, 2],
		])
	})

	test("exponential buckets read as powers of two, signs and zero included", () => {
		for (const org of ["org_exp_delta", "org_exp_cumulative", "org_exp_signed", "org_exp_fine"]) {
			const world = Arr.filter(EXPONENTIAL_WORLD, (s) => s.org === org)
			const expected = exponentialReference(world, 0, 5 * MINUTE_MS, MINUTE_MS)
			expect(expected.length).toBeGreaterThan(1)
			expect(distribution(org, { metricType: "exponential_histogram" })).toEqual(expected)
		}
	})

	test("exemplars keep each time bucket's highest linked values, highest first", () => {
		expect(Arr.map(exemplars(), (e) => [e.value, e.traceId, e.spanId])).toEqual([
			[1_000, "t-thousand", "t-thousand-span"],
			[500, "t-five-hundred", "t-five-hundred-span"],
			[50, "t-fifty", "t-fifty-span"],
			[7, "t-seven", "t-seven-span"],
		])
	})

	test("exemplars follow the chart's filters, the per-bucket cap and the limit", () => {
		const route = (value: string) => ({ key: "http.route", value, mode: "equals" as const })
		expect(Arr.map(exemplars({ attributeFilters: [route("/a")] }), (e) => e.value)).toEqual([
			500, 50, 20, 7,
		])
		expect(Arr.map(exemplars({ perBucket: 1 }), (e) => e.value)).toEqual([1_000, 7])
		expect(exemplars({ serviceName: "worker" })).toEqual([])
	})

	test("the limit takes every bucket's top exemplar before any bucket's second", () => {
		// 0:00 holds 1000, 500 and 50; 1:00 holds only 7, which a cap of two by value would drop.
		expect(Arr.map(exemplars({ limit: 2 }), (e) => e.value)).toEqual([1_000, 7])
	})

	test("an exemplar exported before the window is a repeat inside it, not a new one at its start", () => {
		const fromTwo = (perBucket: number) =>
			Arr.map(exemplars({ perBucket }, 60, RECORDED_ORG, window(2 * MINUTE_MS, 5 * MINUTE_MS)), (e) => [
				e.traceId,
				e.value,
			])
		// t-late (3) was first exported at 1:00.5; only 0.7, first exported at 2:00.5, is new.
		expect(fromTwo(20)).toEqual([["t-late", 0.7]])
	})

	test("an exemplar keeps its own time and the time bucket it falls in", () => {
		const [top] = exemplars()
		expect(top?.serviceName).toBe("api")
		expect(offsetOf(Str.slice(0, 19)(top?.timestamp ?? ""))).toBe(30 * SECOND_MS)
		expect(offsetOf(top?.bucket ?? "")).toBe(0)
	})
	test("an exemplar is bucketed where its datapoint was exported, the heatmap's bucket", () => {
		const [late] = exemplars({}, 60, RECORDED_ORG)
		expect(late?.traceId).toBe("t-late")
		expect(offsetOf(Str.slice(0, 19)(late?.timestamp ?? ""))).toBe(45 * SECOND_MS)
		expect(offsetOf(late?.bucket ?? "")).toBe(MINUTE_MS)
	})

	test("an exemplar repeated on later datapoints is listed once, a new one from its span is not", () => {
		const late = Arr.filter(exemplars({ perBucket: 20 }, 60, RECORDED_ORG), (e) => e.traceId === "t-late")
		expect(Arr.map(late, (e) => [e.value, offsetOf(e.bucket)])).toEqual([
			[3, MINUTE_MS],
			[0.7, 2 * MINUTE_MS],
		])
	})

	test("a negative exponential cell holds its own far edge, as OTel buckets magnitudes", () => {
		const cell = (lowerBound: number, upperBound: number) =>
			Arr.map(
				CH_EXEMPLARS(db, { metricType: "exponential_histogram", cell: { lowerBound, upperBound } }),
				(e) => e.value,
			)
		expect(cell(-4, -2)).toEqual([-4])
		expect(cell(-8, -4)).toEqual([])
	})

	test("a cell's read finds exemplars below the bucket's top values", () => {
		const cell = (lowerBound: number | null, upperBound: number | null) =>
			Arr.map(
				exemplars({ cell: { lowerBound, upperBound } }, 60, RECORDED_ORG, {
					cellBucket: Str.slice(0, 19)(chTimestamp(MINUTE_MS)),
				}),
				(e) => e.traceId,
			)
		// The bucket's top three are t-late, t-low and t-lower; t-lowest is only in its own cell.
		expect(cell(null, 0.1)).toEqual(["t-lowest"])
		expect(cell(0.1, 1)).toEqual(["t-low", "t-lower"])
		expect(cell(1, null)).toEqual(["t-late"])
	})

	test("a point with no buckets has no cell; its neighbours keep theirs", () => {
		expect(distribution(BUCKETLESS_ORG, { metricType: "histogram" })).toEqual([
			[0, null, 10, 1],
			[0, 10, null, 1],
		])
	})

	test("a request's candidate names supersede its scalar name, as MetricsFilters documents", () => {
		const compiled = CH.compileUnsafe(
			CH.histogramDistributionQuery({ metricType: "histogram", metricNames: [METRIC] }),
			{
				orgId: "org_delta",
				metricName: "some.other.name",
				bucketSeconds: 60,
				...window(0, 5 * MINUTE_MS),
			},
		)
		expect(
			decodeDistribution(db.query(normalizeSqlForClickHouseClient(compiled.sql))).length,
		).toBeGreaterThan(0)
	})
})
