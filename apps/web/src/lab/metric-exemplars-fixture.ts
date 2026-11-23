import type { MetricDistributionRow, MetricExemplarRow } from "@maple/domain/http"
import { Array as Arr, String as Str } from "effect"
import type { MetricRow } from "../page/metrics/shared"

// `/lab/metric-exemplars`: one hour of `http.server.request.duration` from `checkout-api`, written
// by hand. Requests take about 60 ms until a slow dependency at 0:38 pushes a slice of them past a
// second for six minutes; the exemplars and the bucket counts tell the same story.

export const EXEMPLARS_METRIC = "http.server.request.duration"
export const EXEMPLARS_NOW = Date.UTC(2026, 10, 22, 15, 0)
const START = EXEMPLARS_NOW - 60 * 60_000
const MINUTES = 60

const iso = (ms: number) => new Date(ms).toISOString()
const minuteAt = (index: number) => START + index * 60_000

/** Minutes 38 to 43 carry the slow dependency. */
const isSlow = (index: number) => index >= 38 && index <= 43

export const EXEMPLARS_CATALOG: ReadonlyArray<MetricRow> = [
	{
		metricName: EXEMPLARS_METRIC,
		metricType: "histogram",
		serviceName: "checkout-api",
		metricDescription: "Duration of HTTP server requests.",
		metricUnit: "s",
		dataPointCount: 14_220,
		firstSeen: "2026-11-21 09:12:00",
		lastSeen: "2026-11-22 15:00:00",
		isMonotonic: false,
	},
]

/** A small deterministic wobble, so the line is not a ruler. */
const wobble = (index: number, salt: number) =>
	((Math.sin(index * 12.9898 + salt * 78.233) + 1) / 2) * 0.3 + 0.85

/** The p95 line the chart reads for the default `p95` aggregation. */
export const EXEMPLARS_TIMESERIES: ReadonlyArray<Readonly<Record<string, string | number>>> = Arr.makeBy(
	MINUTES,
	(index) => ({
		bucket: iso(minuteAt(index)),
		A: isSlow(index) ? 1.42 * wobble(index, 1) : 0.118 * wobble(index, 2),
	}),
)

/** A deterministic hex id of `length` characters. */
const hex = (seed: number, length: number) =>
	Str.slice(
		0,
		length,
	)(
		Arr.join(
			Arr.makeBy(Math.ceil(length / 8), (i) =>
				Str.padStart(8, "0")(((seed * 2654435761 + i * 40503) >>> 0).toString(16)),
			),
			"",
		),
	)

/** Each minute's three highest values, slow minutes and the rest. */
const SLOW_TOP = [2.31, 1.64, 0.91]
const FAST_TOP = [0.142, 0.081, 0.047]

const SERVICES = ["checkout-api", "checkout-api", "payments-worker"]

/** The three highest exemplars of each minute, as the query returns them: highest first overall. */
export const EXEMPLARS_ROWS: ReadonlyArray<MetricExemplarRow> = Arr.sort(
	Arr.flatMap(
		Arr.makeBy(MINUTES, (index) => index),
		(index) =>
			Arr.makeBy(3, (rank): MetricExemplarRow => {
				const seed = index * 3 + rank + 1
				const value = isSlow(index)
					? (SLOW_TOP[rank] ?? 0) * wobble(index, rank)
					: (FAST_TOP[rank] ?? 0) * wobble(index, rank + 3)
				return {
					bucket: iso(minuteAt(index)),
					timestamp: iso(minuteAt(index) + (7 + rank * 17) * 1000),
					value,
					traceId: hex(seed, 32),
					spanId: hex(seed + 7919, 16),
					serviceName: SERVICES[rank] ?? "checkout-api",
				}
			}),
	),
	(a: MetricExemplarRow, b: MetricExemplarRow) => (a.value > b.value ? -1 : a.value < b.value ? 1 : 0),
)

/** The OTel SDK default bounds, in seconds. */
const BOUNDS = [0.005, 0.01, 0.025, 0.05, 0.075, 0.1, 0.25, 0.5, 0.75, 1, 2.5, 5]

/** Requests per bucket per minute: a hump around 50 ms, and in the slow minutes a second one past a second. */
const countAt = (index: number, bucket: number): number => {
	const fast = [4, 22, 160, 410, 290, 120, 38, 6, 1, 0, 0, 0, 0][bucket] ?? 0
	const slow = isSlow(index) ? ([0, 0, 0, 0, 0, 0, 2, 9, 31, 58, 44, 4, 0][bucket] ?? 0) : 0
	return Math.round(fast * wobble(index, bucket + 11) + slow * wobble(index, bucket + 23))
}

export const EXEMPLARS_DISTRIBUTION: ReadonlyArray<MetricDistributionRow> = Arr.flatMap(
	Arr.makeBy(MINUTES, (index) => index),
	(index) =>
		Arr.filter(
			Arr.makeBy(BOUNDS.length + 1, (bucket) => ({
				bucket: iso(minuteAt(index)),
				lowerBound: bucket === 0 ? null : (BOUNDS[bucket - 1] ?? null),
				upperBound: BOUNDS[bucket] ?? null,
				count: countAt(index, bucket),
			})),
			(row) => row.count > 0,
		),
)
