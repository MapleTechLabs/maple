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
	insertExponentialHistogram,
	insertHistograms,
	MINUTE_MS,
	type Observation,
	type QueryArgs,
	queryHistogram,
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
	// A histogram that records only count and sum.
	series("org_no_buckets", { observations: TEN, bounds: [], recordExtrema: false }),
]

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
		// 10 observations summing to 130 between 0:00 and 0:20, exported both ways.
		insertExponentialHistogram(db, "org_exponential_delta", "queue.wait", [
			{ tickMs: 10 * SECOND_MS, startMs: 0, count: 4, sum: 40, temporality: "delta" },
			{ tickMs: 20 * SECOND_MS, startMs: 10 * SECOND_MS, count: 6, sum: 90, temporality: "delta" },
		])
		insertExponentialHistogram(db, "org_exponential_cumulative", "queue.wait", [
			{ tickMs: 0, startMs: -MINUTE_MS, count: 7, sum: 700, temporality: "cumulative" },
			{ tickMs: 10 * SECOND_MS, startMs: -MINUTE_MS, count: 11, sum: 740, temporality: "cumulative" },
			{ tickMs: 20 * SECOND_MS, startMs: -MINUTE_MS, count: 17, sum: 830, temporality: "cumulative" },
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
		expect(Arr.map(firstMinute("org_idle", "count", range), (p) => p.value)).toEqual([0])
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
		expect(Arr.map(points, (p) => [p.observations, p.value])).toEqual([[8, 15]])
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
			const points = randomQuery("org_random_extrema", "sum", bucketSeconds)
			expect(points.length).toBeGreaterThan(10)
			for (const point of points) {
				const values = observedIn(RANDOM_EXTREMA, point.group, point.atMs, bucketSeconds * SECOND_MS)
				expect(point.observations).toBe(values.length)
				expect(point.value).toBe(Arr.reduce(values, 0, (a, b) => a + b))
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

	test("an exponential histogram counts its window whichever way it is exported", () => {
		for (const org of ["org_exponential_delta", "org_exponential_cumulative"]) {
			const read = (aggregation: QueryArgs["aggregation"]) =>
				Arr.map(
					firstMinute(org, aggregation, {
						metric: "queue.wait",
						metricType: "exponential_histogram",
					}),
					(p) => p.value,
				)
			expect(read("count")).toEqual([10])
			expect(read("sum")).toEqual([130])
			expect(read("avg")).toEqual([13])
			// Their buckets are not merged yet, so there is nothing to estimate from.
			expect(read("p95")).toEqual([])
		}
	})
})
