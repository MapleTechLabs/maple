// OTel histogram metrics against a real ClickHouse engine (chDB).
//
// Each world is a list of raw observations, exported the way an SDK would: per interval (delta)
// or as running totals (cumulative), with or without restarts. A query has to report what was
// observed in each bucket whichever way it was exported, and a percentile has to land in the
// histogram bucket the true percentile of those observations is in.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { Array as Arr, Option, Order } from "effect"
import { describeWithChdb } from "./libchdb-test-support"
import { seeded } from "./funnel-scenarios-support"
import {
	type HistogramSeries,
	increaseAt,
	insertCumulativeSamples,
	insertGaugeReadings,
	insertHistograms,
	MINUTE_MS,
	type Observation,
	type QueryArgs,
	queryBreakdown,
	queryHistogram,
	querySparkline,
	SECOND_MS,
	ticksOf,
} from "./histogram-metrics-support"

const at = (seconds: number, value: number): Observation => ({ atMs: seconds * SECOND_MS, value })

/** A series exporting every 10 s for five minutes, starting on the hour. */
const series = (
	org: string,
	overrides: Partial<HistogramSeries> & Pick<HistogramSeries, "observations">,
): HistogramSeries => ({
	org,
	metric: "http.server.request.duration",
	service: "api",
	attributes: {},
	bounds: [10, 20, 50],
	temporality: "delta",
	intervalMs: 10 * SECOND_MS,
	// One export before the window, so a cumulative series has a previous sample to diff against.
	firstTickMs: -10 * SECOND_MS,
	lastTickMs: 5 * MINUTE_MS,
	recordExtrema: true,
	...overrides,
})

// 10 observations in one minute: buckets (..10] 2, (10..20] 4, (20..50] 2, (50..] 2.
const TEN: ReadonlyArray<Observation> = [
	at(1, 5),
	at(2, 5),
	at(11, 15),
	at(12, 15),
	at(21, 15),
	at(22, 15),
	at(31, 30),
	at(32, 30),
	at(41, 60),
	at(42, 100),
]

const WORLDS: ReadonlyArray<HistogramSeries> = [
	series("org_delta", { observations: TEN }),
	series("org_no_extrema", { observations: TEN, recordExtrema: false }),
	series("org_cumulative", { observations: TEN, temporality: "cumulative" }),
	// Restarts at 0:25: the two observations at 0:21 and 0:22 were never exported.
	series("org_restart", {
		observations: TEN,
		temporality: "cumulative",
		restartsAtMs: [25 * SECOND_MS],
	}),
	series("org_single", { observations: [at(5, 12)] }),
	series("org_single_no_extrema", { observations: [at(5, 12)], recordExtrema: false }),
	// Two services with different bucket layouts.
	series("org_mixed", { observations: [at(5, 4), at(6, 12), at(7, 18)], bounds: [10, 20] }),
	series("org_mixed", {
		observations: [at(5, 14), at(6, 16), at(7, 40)],
		bounds: [15],
		service: "worker",
	}),
	// Observed only in the first minute; still exporting its totals afterwards.
	series("org_idle", { observations: [at(5, 12)], temporality: "cumulative" }),
	series("org_grouped", { observations: [at(5, 4), at(6, 6)], attributes: { route: "/a" } }),
	series("org_grouped", { observations: [at(5, 30), at(6, 40)], attributes: { route: "/b" } }),
	// Started on the hour: its first export, at 0:10, is the first sample there is.
	series("org_fresh", { observations: TEN, temporality: "cumulative", firstTickMs: 10 * SECOND_MS }),
	// A job that lives for thirty seconds and exports once.
	series("org_once", {
		observations: [at(5, 12), at(6, 18)],
		temporality: "cumulative",
		intervalMs: 30 * SECOND_MS,
		firstTickMs: 30 * SECOND_MS,
		lastTickMs: 30 * SECOND_MS,
	}),
	// Restarts at 0:20, the instant of an export, and the new process counts past the old total.
	series("org_restart_on_export", {
		observations: [at(5, 5), at(15, 15), at(21, 15), at(22, 15), at(23, 30)],
		temporality: "cumulative",
		restartsAtMs: [20 * SECOND_MS],
	}),
	// One service records min and max, the other does not.
	series("org_some_extrema", { observations: [at(5, 150), at(6, 180)] }),
	series("org_some_extrema", {
		observations: Arr.makeBy(8, (i) => at(10 + i, 3)),
		service: "worker",
		recordExtrema: false,
	}),
	// A histogram that records only count and sum.
	series("org_no_buckets", { observations: TEN, bounds: [], recordExtrema: false }),
	// Two cumulative services, for the per-service table.
	series("org_services", { observations: TEN, temporality: "cumulative" }),
	series("org_services", {
		observations: [at(5, 100), at(65, 200), at(125, 300)],
		temporality: "cumulative",
		service: "worker",
	}),
]

/** How long a series with history has been counting before the range starts. */
const HISTORY_MS = 10 * MINUTE_MS

const LAYOUT = [5, 10, 25, 50, 100, 250, 500, 1000]
const RANDOM_FROM_MS = 5 * MINUTE_MS
const RANDOM_TO_MS = 25 * MINUTE_MS

/** Sixteen series over half an hour. The seed fixes the observations, not how they are exported. */
const randomWorld = (
	org: string,
	temporality: HistogramSeries["temporality"],
	recordExtrema: boolean,
): ReadonlyArray<HistogramSeries> => {
	const rng = seeded(20261115)
	return Arr.makeBy(16, (i) =>
		series(org, {
			attributes: { instance: `i-${i}`, tier: rng.pick(["gold", "silver", "bronze"]) },
			bounds: LAYOUT,
			temporality,
			recordExtrema,
			intervalMs: rng.pick([10, 15, 30, 60]) * SECOND_MS,
			firstTickMs: 0,
			lastTickMs: 30 * MINUTE_MS,
			// Whole numbers from 1 to about 1800, most of them small, so sums stay exact.
			observations: Arr.makeBy(rng.int(400), () =>
				at(rng.int(30 * 60), Math.floor(Math.exp(rng.next() * 7.5))),
			),
		}),
	)
}

const RANDOM_DELTA = randomWorld("org_random_delta", "delta", false)
const RANDOM_CUMULATIVE = randomWorld("org_random_cumulative", "cumulative", false)
const RANDOM_EXTREMA = randomWorld("org_random_extrema", "delta", true)

/** The observations a group's bucket should hold: those its exports in that bucket carried. */
const observedIn = (
	world: ReadonlyArray<HistogramSeries>,
	tier: string,
	bucketMs: number,
	widthMs: number,
): ReadonlyArray<number> =>
	Arr.flatMap(
		Arr.filter(world, (s) => s.attributes.tier === tier),
		(s: HistogramSeries) =>
			Arr.flatMap(
				Arr.filter(
					ticksOf(s),
					(tick) =>
						tick >= RANDOM_FROM_MS &&
						tick <= RANDOM_TO_MS &&
						Math.floor(tick / widthMs) * widthMs === bucketMs,
				),
				(tick: number) => increaseAt(s, tick),
			),
	)

describeWithChdb("histogram metrics", () => {
	let dir: string
	let db: Chdb

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "maple-histogram-"))
		db = Chdb.open({ dataDir: dir, schemaSql })
		insertHistograms(db, [...WORLDS, ...RANDOM_DELTA, ...RANDOM_CUMULATIVE, ...RANDOM_EXTREMA])
		// A scraped series: the first point starts at its own time, the rest at the first point's.
		insertCumulativeSamples(db, "org_scraped", "http.server.request.duration", [
			{ tickMs: 0, startMs: 0, count: 1000, sum: 10_000, bounds: [50], buckets: [1000, 0] },
			{
				tickMs: 10 * SECOND_MS,
				startMs: 0,
				count: 1002,
				sum: 10_020,
				bounds: [50],
				buckets: [1002, 0],
			},
			{
				tickMs: 20 * SECOND_MS,
				startMs: 0,
				count: 1005,
				sum: 10_050,
				bounds: [50],
				buckets: [1005, 0],
			},
		])
		// A scrape that failed at 0:10 leaves a point with no recorded value.
		insertCumulativeSamples(db, "org_stale", "http.server.request.duration", [
			{ tickMs: 0, startMs: -HISTORY_MS, count: 1000, sum: 10_000, bounds: [50], buckets: [1000, 0] },
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 0,
				sum: 0,
				bounds: [],
				buckets: [],
				flags: 1,
			},
			{
				tickMs: 20 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 1003,
				sum: 10_030,
				bounds: [50],
				buckets: [1003, 0],
			},
		])
		// Two libraries in one service record the same metric with the same labels.
		// Two versions of one library loaded side by side, recording the same metric.
		insertCumulativeSamples(
			db,
			"org_scope_versions",
			"http.server.request.duration",
			Arr.map(
				[
					{ tickMs: -10 * SECOND_MS, count: 100, scopeVersion: "1.0.0" },
					{ tickMs: -5 * SECOND_MS, count: 1000, scopeVersion: "2.0.0" },
					{ tickMs: 10 * SECOND_MS, count: 110, scopeVersion: "1.0.0" },
					{ tickMs: 15 * SECOND_MS, count: 1010, scopeVersion: "2.0.0" },
				],
				(sample) => ({
					...sample,
					startMs: -HISTORY_MS,
					sum: sample.count * 10,
					bounds: [50],
					buckets: [sample.count, 0],
					scope: "http",
				}),
			),
		)
		insertCumulativeSamples(db, "org_scopes", "http.server.request.duration", [
			{
				tickMs: -10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 100,
				sum: 1000,
				bounds: [50],
				buckets: [100, 0],
				scope: "a",
			},
			{
				tickMs: -5 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 1000,
				sum: 10_000,
				bounds: [50],
				buckets: [1000, 0],
				scope: "b",
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 110,
				sum: 1100,
				bounds: [50],
				buckets: [110, 0],
				scope: "a",
			},
			{
				tickMs: 15 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 1010,
				sum: 10_100,
				bounds: [50],
				buckets: [1010, 0],
				scope: "b",
			},
		])
		// A sample with a finer layout and no observations, next to one that has them.
		insertCumulativeSamples(db, "org_empty_layout", "http.server.request.duration", [
			{
				tickMs: 10 * SECOND_MS,
				startMs: 0,
				count: 100,
				sum: 5000,
				bounds: [100],
				buckets: [100, 0],
				temporality: "delta",
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: 0,
				count: 0,
				sum: 0,
				bounds: [99, 100],
				buckets: [0, 0, 0],
				temporality: "delta",
				scope: "idle",
			},
		])
		// Two gauge series in one minute: readings 1 to 50, and a flat 10.
		insertGaugeReadings(
			db,
			"org_gauge",
			"queue.depth",
			"api",
			Arr.makeBy(50, (i) => i + 1),
		)
		insertGaugeReadings(
			db,
			"org_gauge",
			"queue.depth",
			"worker",
			Arr.makeBy(50, () => 10),
		)
		// One process, counting since long before the range, that switches its buckets at 0:10.
		insertCumulativeSamples(db, "org_relayout", "http.server.request.duration", [
			{ tickMs: 0, startMs: -HISTORY_MS, count: 5, sum: 50, bounds: [50], buckets: [5, 0] },
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 7,
				sum: 70,
				bounds: [20],
				buckets: [6, 1],
			},
			{
				tickMs: 20 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 10,
				sum: 100,
				bounds: [20],
				buckets: [9, 1],
			},
		])
	})
	afterAll(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})

	const firstMinute = (org: string, aggregation: QueryArgs["aggregation"], extra?: Partial<QueryArgs>) =>
		queryHistogram(db, {
			org,
			metric: "http.server.request.duration",
			aggregation,
			fromMs: 0,
			toMs: 59 * SECOND_MS,
			bucketSeconds: 60,
			...extra,
		})
	const valueOf = (org: string, aggregation: QueryArgs["aggregation"]) =>
		Arr.map(firstMinute(org, aggregation), (p) => p.value)

	test("count, sum and average of a delta histogram", () => {
		expect(valueOf("org_delta", "count")).toEqual([10])
		expect(valueOf("org_delta", "sum")).toEqual([290])
		expect(valueOf("org_delta", "avg")).toEqual([29])
		expect(valueOf("org_delta", "min")).toEqual([5])
		expect(valueOf("org_delta", "max")).toEqual([100])
	})

	test("percentiles interpolate inside the bucket the rank falls in", () => {
		// rank 5 of 10 is the 3rd of 4 in (10..20]; rank 7.5 is 1.5 of 2 into (20..50].
		expect(valueOf("org_delta", "p50")).toEqual([17.5])
		expect(valueOf("org_delta", "p75")).toEqual([42.5])
	})

	test("the unbounded bucket interpolates up to the recorded max", () => {
		// rank 9 is 1 of 2 into (50..], which the max closes at 100.
		expect(valueOf("org_delta", "p90")).toEqual([75])
		expect(valueOf("org_delta", "p99")[0]).toBeCloseTo(97.5, 9)
	})

	test("without a recorded max the unbounded bucket reads as its lower bound", () => {
		expect(valueOf("org_no_extrema", "p90")).toEqual([50])
		expect(valueOf("org_no_extrema", "p50")).toEqual([17.5])
	})

	test("a cumulative histogram reports what the window observed, not its running total", () => {
		for (const aggregation of ["count", "sum", "avg", "p50", "p75"] as const) {
			expect(valueOf("org_cumulative", aggregation)).toEqual(valueOf("org_delta", aggregation))
		}
	})

	test("a restart counts the new process from zero", () => {
		// 8 of the 10 observations were exported: the two at 0:21 and 0:22 died with the process.
		expect(valueOf("org_restart", "count")).toEqual([8])
		expect(valueOf("org_restart", "sum")).toEqual([260])
	})

	test("a series that starts inside the range counts from its first export", () => {
		for (const aggregation of ["count", "sum", "avg", "p50", "p75"] as const) {
			expect(valueOf("org_fresh", aggregation)).toEqual(valueOf("org_delta", aggregation))
		}
		expect(valueOf("org_once", "count")).toEqual([2])
		expect(valueOf("org_once", "sum")).toEqual([30])
	})

	test("a series older than the range does not add the total it arrived with", () => {
		// It arrives with 5 observations summing to 50; the range adds 5 more summing to 50.
		expect(valueOf("org_relayout", "count")).toEqual([5])
		expect(valueOf("org_relayout", "sum")).toEqual([50])
	})

	test("a restart at the instant of an export still starts from zero", () => {
		// The old process exported 2; the new one has 3 by 0:30, which is not an increase of 1.
		expect(valueOf("org_restart_on_export", "count")).toEqual([5])
		expect(valueOf("org_restart_on_export", "sum")).toEqual([80])
	})

	test("new bucket bounds without a restart add no buckets for that export", () => {
		// The export at 0:10 cannot be subtracted from the old layout; 0:20 adds three in (0..20].
		const points = firstMinute("org_relayout", "p50")
		expect(Arr.map(points, (p) => [p.dataPoints, p.value])).toEqual([[5, 10]])
	})

	test("a scraped series, whose start is its first point's time, counts increases only", () => {
		expect(valueOf("org_scraped", "count")).toEqual([5])
		expect(valueOf("org_scraped", "sum")).toEqual([50])
	})

	test("a point with no recorded value is not a reset", () => {
		expect(valueOf("org_stale", "count")).toEqual([3])
		expect(valueOf("org_stale", "sum")).toEqual([30])
	})

	test("one series' min and max do not clamp a distribution other series add to", () => {
		// Eight of ten observations are in (0..10]; the recorded minimum of 150 is one service's.
		expect(valueOf("org_some_extrema", "p50")).toEqual([6.25])
	})

	test("two instrumentation scopes with the same labels are two series", () => {
		expect(valueOf("org_scopes", "count")).toEqual([20])
		expect(valueOf("org_scopes", "sum")).toEqual([200])
	})

	test("two versions of one scope with the same labels are two series", () => {
		expect(valueOf("org_scope_versions", "count")).toEqual([20])
		expect(valueOf("org_scope_versions", "sum")).toEqual([200])
	})

	test("a sample that adds no observations does not move a bucket's lower edge", () => {
		expect(valueOf("org_empty_layout", "p50")).toEqual([50])
	})

	test("a percentile on a gauge is the quantile of each series' readings, averaged over the series", () => {
		const read = (aggregation: QueryArgs["aggregation"]) =>
			Arr.map(
				firstMinute("org_gauge", aggregation, { metric: "queue.depth", metricType: "gauge" }),
				(p) => p.value,
			)
		// Readings 1 to 50 have a median of 25.5; the flat series reads 10; their average is 17.75.
		expect(read("p50")).toEqual([17.75])
		expect(read("p95")[0]).toBeCloseTo((47.55 + 10) / 2, 9)
	})

	test("an estimate never leaves the recorded min and max", () => {
		expect(valueOf("org_single", "p50")).toEqual([12])
		expect(valueOf("org_single", "p99")).toEqual([12])
		// Without extrema the bucket (10..20] is all there is to go on.
		expect(valueOf("org_single_no_extrema", "p50")).toEqual([15])
	})

	test("series with different bucket layouts merge by upper bound", () => {
		// Merged bounds 10, 15, 20, inf hold 1, 1, 2, 2; rank 3 is 1 of 2 into (15..20].
		expect(valueOf("org_mixed", "count")).toEqual([6])
		expect(valueOf("org_mixed", "p50")).toEqual([17.5])
	})

	test("a bucket with no observations has a count of zero and no average or percentile", () => {
		const range = { fromMs: 2 * MINUTE_MS, toMs: 3 * MINUTE_MS - SECOND_MS }
		// The six exports in the minute still count as data, so an alert can read the zero.
		expect(Arr.map(firstMinute("org_idle", "count", range), (p) => [p.value, p.dataPoints])).toEqual([
			[0, 6],
		])
		expect(firstMinute("org_idle", "avg", range)).toEqual([])
		expect(firstMinute("org_idle", "p95", range)).toEqual([])
	})

	test("groups keep their own distribution", () => {
		const points = firstMinute("org_grouped", "p50", { groupByAttributeKey: "route" })
		expect(Arr.map(points, (p) => [p.group, p.value])).toEqual([
			["/a", 5],
			["/b", 35],
		])
	})

	test("a series cap keeps the groups with the highest percentile", () => {
		const points = firstMinute("org_grouped", "p50", {
			groupByAttributeKey: "route",
			seriesLimit: 1,
			wholeRange: true,
		})
		expect(Arr.map(points, (p) => [p.group, p.value])).toEqual([["/b", 35]])
	})

	test("a histogram without buckets has an average but no percentile", () => {
		expect(valueOf("org_no_buckets", "avg")).toEqual([29])
		expect(valueOf("org_no_buckets", "p50")).toEqual([])
	})

	test("an alert window reads the whole range as one bucket", () => {
		const points = firstMinute("org_cumulative", "p50", {
			fromMs: 7 * SECOND_MS,
			toMs: 47 * SECOND_MS,
			wholeRange: true,
			lookbackSeconds: 30,
		})
		// Exports at 0:10 to 0:40 carry the eight observations up to 0:32 (the window end is exclusive).
		expect(Arr.map(points, (p) => [p.dataPoints, p.value])).toEqual([[8, 15]])
	})

	test("the catalog sparkline of a cumulative histogram plots the window, not the running total", () => {
		const sparkline = (org: string) =>
			querySparkline(db, {
				org,
				metric: "http.server.request.duration",
				metricType: "histogram",
				fromMs: 0,
				toMs: 5 * MINUTE_MS,
				bucketSeconds: 60,
			})
		// All ten observations are in the first minute; later minutes observed nothing.
		expect(sparkline("org_cumulative")).toEqual([[0, 29, 290, 10]])
		expect(sparkline("org_cumulative")).toEqual(sparkline("org_delta"))
		// Three minutes, each with one observation of the worker's next to the api's first minute.
		expect(sparkline("org_services")).toEqual([
			[0, 390 / 11, 390, 11],
			[MINUTE_MS, 200, 200, 1],
			[2 * MINUTE_MS, 300, 300, 1],
		])
	})

	test("the per-service table of a cumulative histogram agrees with the chart", () => {
		const range = {
			org: "org_services",
			metric: "http.server.request.duration",
			fromMs: 0,
			toMs: 5 * MINUTE_MS,
		}
		const table = queryBreakdown(db, {
			...range,
			metricType: "histogram",
			options: { lookbackSeconds: 60 },
		})
		expect(table).toEqual([
			["api", 29, 290, 10],
			["worker", 200, 600, 3],
		])
		for (const [aggregation, column] of [
			["sum", 2],
			["count", 3],
		] as const) {
			const chart = queryHistogram(db, {
				...range,
				aggregation,
				bucketSeconds: 60,
				groupByService: true,
			})
			for (const row of table) {
				const charted = Arr.filter(chart, (p) => p.group === row[0])
				expect(Arr.reduce(charted, 0, (total, p) => total + p.value)).toBe(row[column])
			}
		}
	})

	test("a histogram breakdown groups by a label and keeps its filters", () => {
		const breakdown = (org: string, options: Parameters<typeof queryBreakdown>[1]["options"]) =>
			queryBreakdown(db, {
				org,
				metric: "http.server.request.duration",
				metricType: "histogram",
				fromMs: 0,
				toMs: 5 * MINUTE_MS,
				options,
			})
		expect(breakdown("org_grouped", { groupByAttributeKey: "route", rankBy: "sum" })).toEqual([
			["/b", 35, 70, 2],
			["/a", 5, 10, 2],
		])
		expect(
			breakdown("org_grouped", {
				groupByAttributeKey: "route",
				attributeFilters: [{ key: "route", mode: "equals", value: "/a" }],
			}),
		).toEqual([["/a", 5, 10, 2]])
		expect(breakdown("org_mixed", { serviceName: "worker" })).toEqual([["worker", 70 / 3, 70, 3]])
		expect(breakdown("org_mixed", { rankBy: "sum", limit: 1 })).toEqual([["worker", 70 / 3, 70, 3]])
	})

	const randomQuery = (org: string, aggregation: QueryArgs["aggregation"], bucketSeconds: number) =>
		queryHistogram(db, {
			org,
			metric: "http.server.request.duration",
			aggregation,
			fromMs: RANDOM_FROM_MS,
			toMs: RANDOM_TO_MS,
			bucketSeconds,
			groupByAttributeKey: "tier",
		})

	test("the same observations read the same exported per interval or as running totals", () => {
		for (const bucketSeconds of [60, 300]) {
			for (const aggregation of ["count", "sum", "avg", "p50", "p95", "p99"] as const) {
				const delta = randomQuery("org_random_delta", aggregation, bucketSeconds)
				expect(delta.length).toBeGreaterThan(10)
				expect(randomQuery("org_random_cumulative", aggregation, bucketSeconds)).toEqual(delta)
			}
		}
	})

	test("a bucket counts exactly the observations exported in it", () => {
		for (const bucketSeconds of [60, 300]) {
			const counts = randomQuery("org_random_extrema", "count", bucketSeconds)
			const sums = randomQuery("org_random_extrema", "sum", bucketSeconds)
			expect(counts.length).toBeGreaterThan(10)
			expect(sums.length).toBe(counts.length)
			for (const [points, total] of [
				[counts, (values: ReadonlyArray<number>) => values.length],
				[sums, (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (a, b) => a + b)],
			] as const) {
				for (const point of points) {
					const width = bucketSeconds * SECOND_MS
					expect(point.value).toBe(
						total(observedIn(RANDOM_EXTREMA, point.group, point.atMs, width)),
					)
				}
			}
		}
	})

	test("a percentile lands in the bucket the true percentile is in", () => {
		for (const [aggregation, q] of [
			["p50", 0.5],
			["p90", 0.9],
			["p99", 0.99],
		] as const) {
			for (const point of randomQuery("org_random_extrema", aggregation, 300)) {
				const sorted = Arr.sort(
					observedIn(RANDOM_EXTREMA, point.group, point.atMs, 300 * SECOND_MS),
					Order.Number,
				)
				const truth = sorted[Math.ceil(q * sorted.length) - 1] ?? Number.NaN
				const index = Option.getOrElse(
					Arr.findFirstIndex(LAYOUT, (bound) => truth <= bound),
					() => LAYOUT.length,
				)
				const lowest = sorted[0] ?? Number.NaN
				const highest = sorted[sorted.length - 1] ?? Number.NaN
				expect(point.value).toBeGreaterThanOrEqual(Math.max(LAYOUT[index - 1] ?? 0, lowest))
				expect(point.value).toBeLessThanOrEqual(Math.min(LAYOUT[index] ?? highest, highest))
			}
		}
	})
})
