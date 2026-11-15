// OTel exponential histogram metrics against a real ClickHouse engine (chDB).
//
// Each world is a list of raw observations, exported the way an SDK holding base-2 exponential
// buckets would: per interval (delta) or as running totals (cumulative), halving its resolution
// when the values outgrow its bucket budget. A percentile is checked against a value worked
// out by hand, and against the bucket the true percentile of those observations is in.

import { afterAll, beforeAll, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import schemaSql from "@maple/local-server/schema/local-schema.sql" with { type: "text" }
import { Chdb } from "@maple/local-server/chdb"
import { Array as Arr, Order } from "effect"
import { describeWithChdb } from "./libchdb-test-support"
import { seeded } from "./funnel-scenarios-support"
import {
	type ExponentialSeries,
	exponentialBounds,
	exponentialIndex,
	exportedBuckets,
	increaseAt,
	insertExponentialHistograms,
	insertExponentialSamples,
	MINUTE_MS,
	type Observation,
	type QueryArgs,
	queryBreakdown,
	queryHistogram,
	querySparkline,
	SECOND_MS,
	ticksOf,
} from "./histogram-metrics-support"

const METRIC = "db.client.operation.duration"

const at = (seconds: number, value: number): Observation => ({ atMs: seconds * SECOND_MS, value })

/** A series exporting every 10 s for five minutes, starting on the hour, with buckets (2^k, 2^(k+1)]. */
const series = (
	org: string,
	overrides: Partial<ExponentialSeries> & Pick<ExponentialSeries, "observations">,
): ExponentialSeries => ({
	org,
	metric: METRIC,
	service: "api",
	attributes: {},
	temporality: "delta",
	intervalMs: 10 * SECOND_MS,
	// One export before the window, so a cumulative series has a previous sample to diff against.
	firstTickMs: -10 * SECOND_MS,
	lastTickMs: 5 * MINUTE_MS,
	recordExtrema: true,
	maxScale: 0,
	maxSize: 160,
	...overrides,
})

// 10 observations in one minute: buckets (1..2] 1, (2..4] 2, (4..8] 4, (8..16] 2, (16..32] 1.
const TEN: ReadonlyArray<Observation> = [
	at(1, 1.5),
	at(2, 3),
	at(11, 3),
	at(12, 6),
	at(21, 6),
	at(22, 6),
	at(31, 6),
	at(32, 12),
	at(41, 12),
	at(42, 24),
]

// Mostly below zero, with one zero and one positive value:
// [-32..-16) 1, [-16..-8) 2, [-8..-4) 5, zero 1, (2..4] 1.
const SIGNED: ReadonlyArray<Observation> = Arr.map([-24, -12, -12, -6, -6, -6, -6, -6, 0, 3], (value, i) =>
	at(i + 1, value),
)

const WORLDS: ReadonlyArray<ExponentialSeries> = [
	series("org_delta", { observations: TEN }),
	series("org_no_extrema", { observations: TEN, recordExtrema: false }),
	series("org_cumulative", { observations: TEN, temporality: "cumulative" }),
	// Restarts at 0:25: the two observations at 0:21 and 0:22 were never exported.
	series("org_restart", { observations: TEN, temporality: "cumulative", restartsAtMs: [25 * SECOND_MS] }),
	// Started on the hour: its first export, at 0:10, is the first sample there is.
	series("org_fresh", { observations: TEN, temporality: "cumulative", firstTickMs: 10 * SECOND_MS }),
	series("org_signed", { observations: SIGNED }),
	series("org_zeros", { observations: [at(1, 0), at(2, 0), at(3, 0)] }),
	// Two services at different resolutions: quarter-power buckets and whole-power buckets.
	series("org_mixed", { observations: [at(5, 2.5), at(6, 3.5)], maxScale: 2 }),
	series("org_mixed", { observations: [at(5, 3), at(6, 12)], service: "worker" }),
	series("org_grouped", { observations: [at(5, 3), at(6, 3)], attributes: { route: "/a" } }),
	series("org_grouped", { observations: [at(5, 24), at(6, 24)], attributes: { route: "/b" } }),
	// Two cumulative services, for the per-service table.
	series("org_services", { observations: TEN, temporality: "cumulative" }),
	series("org_services", {
		observations: [at(5, 100), at(65, 200), at(125, 300)],
		temporality: "cumulative",
		service: "worker",
	}),
]

const RANDOM_FROM_MS = 5 * MINUTE_MS
const RANDOM_TO_MS = 25 * MINUTE_MS

interface Exporters {
	readonly temporality: (i: number) => ExponentialSeries["temporality"]
	readonly recordExtrema: boolean
	readonly maxScale: (i: number) => number
	readonly maxSize: number
	readonly restartsAtMs?: (i: number) => ReadonlyArray<number>
}

/** Sixteen series over half an hour. The seed fixes the observations, not how they are exported. */
const randomWorld = (org: string, exporters: Exporters): ReadonlyArray<ExponentialSeries> => {
	const rng = seeded(20261115)
	return Arr.makeBy(16, (i) =>
		series(org, {
			attributes: { instance: `i-${i}`, tier: rng.pick(["gold", "silver", "bronze"]) },
			temporality: exporters.temporality(i),
			recordExtrema: exporters.recordExtrema,
			maxScale: exporters.maxScale(i),
			maxSize: exporters.maxSize,
			restartsAtMs: exporters.restartsAtMs?.(i),
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

// Roomy enough that no series ever lowers its scale: both exports hold the same buckets.
const STEADY = { maxScale: () => 3, maxSize: 160 }
const RANDOM_DELTA = randomWorld("org_random_delta", {
	...STEADY,
	temporality: () => "delta",
	recordExtrema: false,
})
const RANDOM_CUMULATIVE = randomWorld("org_random_cumulative", {
	...STEADY,
	temporality: () => "cumulative",
	recordExtrema: false,
})
const RANDOM_EXTREMA = randomWorld("org_random_extrema", {
	...STEADY,
	temporality: () => "delta",
	recordExtrema: true,
})
// 24 buckets hold about half the value range at scale 2, so a cumulative series halves its
// resolution as it goes (4, 3, 2, 1) and starts over after a restart; the delta series next
// to them export every interval at whatever scale that interval's values fit.
const RANDOM_RESCALED = randomWorld("org_random_rescaled", {
	temporality: (i) => (i % 3 === 0 ? "delta" : "cumulative"),
	recordExtrema: false,
	maxScale: (i) => [4, 4, 2][i % 3] ?? 4,
	maxSize: 24,
	restartsAtMs: (i) => (i % 4 === 1 ? [(8 + i) * MINUTE_MS + 7 * SECOND_MS] : []),
})

type GroupKey = "tier" | "instance"

/** The exports of a group's bucket: each tick with the observations it adds. */
const exportsIn = (
	world: ReadonlyArray<ExponentialSeries>,
	key: GroupKey,
	group: string,
	bucketMs: number,
	widthMs: number,
) =>
	Arr.flatMap(
		Arr.filter(world, (s) => s.attributes[key] === group),
		(s: ExponentialSeries) =>
			Arr.map(
				Arr.filter(
					ticksOf(s),
					(tick) =>
						tick >= RANDOM_FROM_MS &&
						tick <= RANDOM_TO_MS &&
						Math.floor(tick / widthMs) * widthMs === bucketMs,
				),
				(tick: number) => ({ series: s, tick, values: increaseAt(s, tick) }),
			),
	)

const observedIn = (
	world: ReadonlyArray<ExponentialSeries>,
	tier: string,
	bucketMs: number,
	widthMs: number,
) => Arr.flatMap(exportsIn(world, "tier", tier, bucketMs, widthMs), (exported) => exported.values)

const HISTORY_MS = 10 * MINUTE_MS

describeWithChdb("exponential histogram metrics", () => {
	let dir: string
	let db: Chdb

	beforeAll(() => {
		dir = mkdtempSync(join(tmpdir(), "maple-exponential-"))
		db = Chdb.open({ dataDir: dir, schemaSql })
		insertExponentialHistograms(db, [
			...WORLDS,
			...RANDOM_DELTA,
			...RANDOM_CUMULATIVE,
			...RANDOM_EXTREMA,
			...RANDOM_RESCALED,
		])
		// One process, counting since long before the range, that halves its resolution at 0:20.
		// Scale 1 buckets are (2^(k/2), 2^((k+1)/2)]: 2 and 3 are the two halves of (2..4].
		insertExponentialSamples(db, "org_rescale", METRIC, [
			{
				tickMs: 0,
				startMs: -HISTORY_MS,
				count: 4,
				sum: 11,
				scale: 1,
				positive: { offset: 2, counts: [3, 1] },
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 7,
				sum: 20,
				scale: 1,
				positive: { offset: 2, counts: [5, 2] },
			},
			// One more in (2..4] and one in (16..32].
			{
				tickMs: 20 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 9,
				sum: 43,
				scale: 0,
				positive: { offset: 1, counts: [8, 0, 0, 1] },
			},
		])
		// A resolution that goes up inside one accumulation: 4 in (2..4], then 5 and 1 in its halves.
		insertExponentialSamples(db, "org_scale_up", METRIC, [
			{
				tickMs: 0,
				startMs: -HISTORY_MS,
				count: 4,
				sum: 12,
				scale: 0,
				positive: { offset: 1, counts: [4] },
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 6,
				sum: 18,
				scale: 1,
				positive: { offset: 2, counts: [5, 1] },
			},
		])
		// An empty first export at scale 0, then four observations in quarter-power buckets.
		insertExponentialSamples(db, "org_empty_first", METRIC, [
			{ tickMs: 0, startMs: -HISTORY_MS, count: 0, sum: 0, scale: 0 },
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 4,
				sum: 12,
				scale: 2,
				positive: { offset: 5, counts: [2, 0, 2] },
			},
		])
		// Four observations in quarter-power buckets, next to a series at scale 0 that adds none.
		insertExponentialSamples(db, "org_idle_coarse", METRIC, [
			{
				tickMs: 10 * SECOND_MS,
				startMs: 0,
				count: 4,
				sum: 12,
				scale: 2,
				positive: { offset: 5, counts: [2, 0, 2] },
				temporality: "delta",
			},
			...Arr.map([0, 10 * SECOND_MS, 20 * SECOND_MS], (tickMs) => ({
				tickMs,
				startMs: -HISTORY_MS,
				count: 50,
				sum: 150,
				scale: 0,
				positive: { offset: 1, counts: [50] },
				service: "worker",
			})),
		])
		// A bucket that loses one observation while the count goes up by three.
		insertExponentialSamples(db, "org_decrease", METRIC, [
			{
				tickMs: 0,
				startMs: -HISTORY_MS,
				count: 7,
				sum: 30,
				scale: 0,
				positive: { offset: 1, counts: [5, 2] },
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 10,
				sum: 45,
				scale: 0,
				positive: { offset: 1, counts: [4, 6] },
			},
		])
		// Two samples of one series whose buckets are 1.8 million indexes apart.
		insertExponentialSamples(db, "org_far_apart", METRIC, [
			{
				tickMs: 0,
				startMs: -HISTORY_MS,
				count: 1,
				sum: 2,
				scale: 20,
				positive: { offset: 900_000, counts: [1] },
			},
			{
				tickMs: 10 * SECOND_MS,
				startMs: -HISTORY_MS,
				count: 3,
				sum: 4,
				scale: 20,
				positive: { offset: -900_000, counts: [1, 1] },
			},
		])
		// An SDK that records only count and sum.
		insertExponentialSamples(db, "org_no_buckets", METRIC, [
			{ tickMs: 10 * SECOND_MS, startMs: 0, count: 4, sum: 40, scale: 0, temporality: "delta" },
		])
	})
	afterAll(() => {
		db.close()
		rmSync(dir, { recursive: true, force: true })
	})

	const firstMinute = (org: string, aggregation: QueryArgs["aggregation"], extra?: Partial<QueryArgs>) =>
		queryHistogram(db, {
			org,
			metric: METRIC,
			metricType: "exponential_histogram",
			aggregation,
			fromMs: 0,
			toMs: 59 * SECOND_MS,
			bucketSeconds: 60,
			...extra,
		})
	const valueOf = (org: string, aggregation: QueryArgs["aggregation"]) =>
		Arr.map(firstMinute(org, aggregation), (p) => p.value)
	const only = (org: string, aggregation: QueryArgs["aggregation"]): number => {
		const values = valueOf(org, aggregation)
		expect(values.length).toBe(1)
		return values[0] ?? Number.NaN
	}

	test("count, sum and average of a delta exponential histogram", () => {
		expect(valueOf("org_delta", "count")).toEqual([10])
		expect(valueOf("org_delta", "sum")).toEqual([79.5])
		expect(valueOf("org_delta", "avg")).toEqual([7.95])
		expect(valueOf("org_delta", "min")).toEqual([1.5])
		expect(valueOf("org_delta", "max")).toEqual([24])
	})

	test("percentiles interpolate on the logarithm inside the bucket the rank falls in", () => {
		// rank 5 of 10 is 2 of 4 into (4..8]: 2^(2 + 0.5). rank 7.5 is 0.5 of 2 into (8..16]: 2^(3 + 0.25).
		expect(only("org_delta", "p50")).toBeCloseTo(2 ** 2.5, 9)
		expect(only("org_delta", "p75")).toBeCloseTo(2 ** 3.25, 9)
		// rank 9 is the last of (8..16], its upper edge.
		expect(only("org_delta", "p90")).toBeCloseTo(16, 9)
	})

	test("an estimate never leaves the recorded min and max", () => {
		// rank 9.9 is 0.9 into (16..32], 2^4.9, and nothing above 24 was recorded.
		expect(valueOf("org_delta", "p99")).toEqual([24])
		expect(only("org_no_extrema", "p99")).toBeCloseTo(2 ** 4.9, 9)
	})

	test("a cumulative exponential histogram reports what the window observed, not its running total", () => {
		for (const aggregation of ["count", "sum", "avg", "p50", "p75", "p99"] as const) {
			expect(valueOf("org_cumulative", aggregation)).toEqual(valueOf("org_delta", aggregation))
			expect(valueOf("org_fresh", aggregation)).toEqual(valueOf("org_delta", aggregation))
		}
	})

	test("a restart counts the new process from zero", () => {
		// 8 of the 10 observations were exported: the two 6s at 0:21 and 0:22 died with the process.
		expect(valueOf("org_restart", "count")).toEqual([8])
		expect(valueOf("org_restart", "sum")).toEqual([67.5])
		// Buckets hold 1, 2, 2, 2, 1; rank 6 is 0.5 of 2 into (8..16].
		expect(only("org_restart", "p75")).toBeCloseTo(2 ** 3.5, 9)
	})

	test("negative buckets are walked from the largest magnitude, through zero, to the positive ones", () => {
		expect(valueOf("org_signed", "count")).toEqual([10])
		expect(valueOf("org_signed", "sum")).toEqual([-75])
		// rank 5 is 2 of 5 into [-8..-4), from its far edge: -2^(3 - 0.4). rank 7.5 is 4.5 of 5 into it.
		expect(only("org_signed", "p50")).toBeCloseTo(-(2 ** 2.6), 9)
		expect(only("org_signed", "p75")).toBeCloseTo(-(2 ** 2.1), 9)
		// rank 9 is the zero bucket; rank 9.5 is 0.5 of 1 into (2..4]; the max, 3, bounds p99.
		expect(valueOf("org_signed", "p90")).toEqual([0])
		expect(only("org_signed", "p95")).toBeCloseTo(2 ** 1.5, 9)
		expect(valueOf("org_signed", "p99")).toEqual([3])
	})

	test("a histogram of zeros has percentiles of zero", () => {
		expect(valueOf("org_zeros", "p50")).toEqual([0])
		expect(valueOf("org_zeros", "p99")).toEqual([0])
	})

	test("a lower scale inside one accumulation is subtracted at the new scale", () => {
		// 0:10 adds 2 and 1 to the halves of (2..4]; 0:20, now at scale 0, adds 1 there and 1 in (16..32].
		expect(valueOf("org_rescale", "count")).toEqual([5])
		expect(valueOf("org_rescale", "sum")).toEqual([32])
		// (2..4] holds 4 and (16..32] holds 1: rank 2.5 is 0.625 into the first, rank 4.75 is 0.75 into the last.
		expect(only("org_rescale", "p50")).toBeCloseTo(2 ** 1.625, 9)
		expect(only("org_rescale", "p95")).toBeCloseTo(2 ** 4.75, 9)
	})

	test("a higher scale inside one accumulation is subtracted at the old scale", () => {
		// (2..4] went from 4 to 6: rank 1 of 2 is 0.5 into it.
		expect(valueOf("org_scale_up", "count")).toEqual([2])
		expect(only("org_scale_up", "p50")).toBeCloseTo(2 ** 1.5, 9)
	})

	test("an empty previous sample does not decide the resolution", () => {
		// Buckets (2^1.25..2^1.5] and (2^1.75..4] hold 2 each: rank 3 is 0.5 into the second.
		expect(only("org_empty_first", "p75")).toBeCloseTo(2 ** 1.875, 9)
	})

	test("a series that adds no observations does not coarsen the others", () => {
		expect(valueOf("org_idle_coarse", "count")).toEqual([4])
		expect(only("org_idle_coarse", "p75")).toBeCloseTo(2 ** 1.875, 9)
	})

	test("a bucket that shrinks without a restart adds nothing", () => {
		// (2..4] lost one and (4..8] gained four: rank 2 of those four is 0.5 into (4..8].
		expect(only("org_decrease", "p50")).toBeCloseTo(2 ** 2.5, 9)
	})

	test("samples too far apart to be one distribution add no buckets", () => {
		expect(valueOf("org_far_apart", "count")).toEqual([2])
		expect(valueOf("org_far_apart", "p50")).toEqual([])
	})

	test("series at different scales merge at the lowest one", () => {
		// The api's 2.5 and 3.5 fall in (2..4] with the worker's 3; its 12 is alone in (8..16].
		expect(valueOf("org_mixed", "count")).toEqual([4])
		expect(only("org_mixed", "p50")).toBeCloseTo(2 ** (1 + 2 / 3), 9)
		// On its own the api keeps quarter-power buckets: rank 1 of 2 is the upper edge of (2^1.25..2^1.5].
		const points = firstMinute("org_mixed", "p50", { groupByService: true })
		expect(Arr.map(points, (p) => p.group)).toEqual(["api", "worker"])
		expect(points[0]?.value).toBeCloseTo(2 ** 1.5, 9)
		expect(points[1]?.value).toBeCloseTo(2 ** 2, 9)
	})

	test("groups keep their own distribution", () => {
		const points = firstMinute("org_grouped", "p50", { groupByAttributeKey: "route" })
		// Both of a route's observations share a bucket; the recorded extrema pin them down.
		expect(Arr.map(points, (p) => [p.group, p.value])).toEqual([
			["/a", 3],
			["/b", 24],
		])
	})

	test("a histogram without buckets has an average but no percentile", () => {
		expect(valueOf("org_no_buckets", "avg")).toEqual([10])
		expect(valueOf("org_no_buckets", "p50")).toEqual([])
	})

	test("an alert window reads the whole range as one bucket", () => {
		const points = firstMinute("org_cumulative", "p50", {
			fromMs: 7 * SECOND_MS,
			toMs: 47 * SECOND_MS,
			wholeRange: true,
			lookbackSeconds: 30,
		})
		// Exports at 0:10 to 0:40 carry the eight observations up to 0:32 (the window end is exclusive):
		// (1..2] 1, (2..4] 2, (4..8] 4, (8..16] 1. Rank 4 is 0.25 into (4..8].
		expect(Arr.map(points, (p) => p.dataPoints)).toEqual([8])
		expect(points[0]?.value).toBeCloseTo(2 ** 2.25, 9)
	})

	test("the catalog sparkline of a cumulative histogram plots the window, not the running total", () => {
		const sparkline = (org: string) =>
			querySparkline(db, {
				org,
				metric: METRIC,
				metricType: "exponential_histogram",
				fromMs: 0,
				toMs: 5 * MINUTE_MS,
				bucketSeconds: 60,
			})
		// All ten observations are in the first minute; later minutes observed nothing.
		expect(sparkline("org_cumulative")).toEqual([[0, 7.95, 79.5, 10]])
		expect(sparkline("org_cumulative")).toEqual(sparkline("org_delta"))
	})

	test("the per-service table of a cumulative histogram agrees with the chart", () => {
		const range = { org: "org_services", metric: METRIC, fromMs: 0, toMs: 5 * MINUTE_MS }
		const table = queryBreakdown(db, {
			...range,
			metricType: "exponential_histogram",
			options: { lookbackSeconds: 60 },
		})
		expect(table).toEqual([
			["api", 7.95, 79.5, 10],
			["worker", 200, 600, 3],
		])
		for (const [aggregation, column] of [
			["sum", 2],
			["count", 3],
		] as const) {
			const chart = queryHistogram(db, {
				...range,
				metricType: "exponential_histogram",
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

	const randomQuery = (
		org: string,
		aggregation: QueryArgs["aggregation"],
		bucketSeconds: number,
		groupBy: GroupKey = "tier",
	) =>
		queryHistogram(db, {
			org,
			metric: METRIC,
			metricType: "exponential_histogram",
			aggregation,
			fromMs: RANDOM_FROM_MS,
			toMs: RANDOM_TO_MS,
			bucketSeconds,
			groupByAttributeKey: groupBy,
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

	test("a bucket counts exactly the observations exported in it, through scale changes and restarts", () => {
		for (const world of [RANDOM_EXTREMA, RANDOM_RESCALED]) {
			const org = world[0]?.org ?? ""
			for (const bucketSeconds of [60, 300]) {
				const counts = randomQuery(org, "count", bucketSeconds)
				const sums = randomQuery(org, "sum", bucketSeconds)
				expect(counts.length).toBeGreaterThan(10)
				expect(sums.length).toBe(counts.length)
				for (const [points, total] of [
					[counts, (values: ReadonlyArray<number>) => values.length],
					[sums, (values: ReadonlyArray<number>) => Arr.reduce(values, 0, (a, b) => a + b)],
				] as const) {
					for (const point of points) {
						const width = bucketSeconds * SECOND_MS
						expect(point.value).toBe(total(observedIn(world, point.group, point.atMs, width)))
					}
				}
			}
		}
	})

	test("a percentile lands in the bucket the true percentile is in", () => {
		// By tier, series at different scales merge; by instance, one series changes scale as it goes.
		for (const [world, groupBy] of [
			[RANDOM_EXTREMA, "tier"],
			[RANDOM_RESCALED, "tier"],
			[RANDOM_RESCALED, "instance"],
		] as const) {
			const org = world[0]?.org ?? ""
			const mergedScales = new Set<number>()
			const exportedScales = new Set<number>()
			for (const [aggregation, q] of [
				["p50", 0.5],
				["p90", 0.9],
				["p99", 0.99],
			] as const) {
				const points = randomQuery(org, aggregation, 300, groupBy)
				expect(points.length).toBeGreaterThan(10)
				for (const point of points) {
					const exported = exportsIn(world, groupBy, point.group, point.atMs, 300 * SECOND_MS)
					const sorted = Arr.sort(
						Arr.flatMap(exported, (e) => e.values),
						Order.Number,
					)
					const truth = sorted[Math.ceil(q * sorted.length) - 1] ?? Number.NaN
					const scalesIn = Arr.map(
						Arr.filter(exported, (e) => e.values.length > 0),
						(e) => exportedBuckets(e.series, e.tick).scale,
					)
					Arr.forEach(scalesIn, (scale) => exportedScales.add(scale))
					// The merged buckets are as coarse as the coarsest export that added to them.
					const scale = Math.min(...scalesIn)
					mergedScales.add(scale)
					const [lower, upper] = exponentialBounds(exponentialIndex(truth, scale), scale)
					expect(point.value).toBeGreaterThanOrEqual(lower * (1 - 1e-12))
					expect(point.value).toBeLessThanOrEqual(upper * (1 + 1e-12))
					if (world === RANDOM_EXTREMA) {
						expect(point.value).toBeGreaterThanOrEqual(sorted[0] ?? Number.NaN)
						expect(point.value).toBeLessThanOrEqual(sorted[sorted.length - 1] ?? Number.NaN)
					}
				}
			}
			// The rescaled world is only a test of rescaling if its exports did differ in scale,
			// and its series did end up at different ones.
			if (world === RANDOM_RESCALED) expect(exportedScales.size).toBeGreaterThan(2)
			if (groupBy === "instance") expect(mergedScales.size).toBeGreaterThan(1)
		}
	})
})
