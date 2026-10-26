import { focusCrosshair, focusDot } from "@maple/ui/components/plot/plot-focus"
import { niceLinearDomain } from "@maple/ui/components/plot/plot-scales"
import {
	axisTickFormatter,
	formatBucketLabel,
	formatErrorRate,
	formatLatency,
	formatThroughput,
	inferBucketSeconds,
	inferRangeMs,
} from "@maple/ui/lib/format"
import { areaY, type ChartValue, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { scalePoint } from "@tanstack/charts-scales/point"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { verticalGradient } from "./fixed-metric-axes"
import { cursorTooltip } from "./plot-constants"

// The `/lab/bench/tanstack` chart definitions: throughput area, error rate area and latency line.

type BenchSpec = Extract<ChartSpec, { readonly _tag: "BenchOverview" }>
type Row = BenchSpec["rows"][number]

interface Series {
	readonly label: string
	readonly key: string
	readonly color: string
	readonly dashed: boolean
	readonly format: (value: number) => string
}

const bucketOf = (row: Row): string => {
	const value = row["bucket"]
	return typeof value === "string" ? value : ""
}
const numberOf = (row: Row, key: string): number => {
	const value = row[key]
	return typeof value === "number" ? value : 0
}

/** `scales.x`: a point scale over the buckets, ticks every 72px. */
const xScale = (axisContext: { rangeMs: number; bucketSeconds: number | undefined }) => ({
	scale: scalePoint,
	axis: {
		line: false,
		ticks: {
			size: 0,
			padding: 8,
			spacing: 72,
			format: (value: string) => formatBucketLabel(value, axisContext, "tick"),
		},
	},
})

const yScale = (domain: readonly [number, number], format: (value: number) => string, nice: boolean) => ({
	scale: scaleLinear().domain(domain),
	nice,
	grid: true,
	axis: {
		line: false,
		ticks: { size: 0, padding: 6, format: (value: number) => (value === 0 ? "0" : format(value)) },
	},
})

/** The series a chart draws, in paint order, with the per-second rows throughput reads. */
const seriesOf = (spec: BenchSpec, rateLabel: string): ReadonlyArray<Series> => {
	const color = (key: string) => spec.colors[key] ?? ""
	const perSecond = (value: number) => `${value.toLocaleString()}${rateLabel}`
	switch (spec.chart) {
		case "Throughput":
			return [
				{
					label: "Throughput",
					key: "throughput",
					color: color("throughput"),
					dashed: false,
					format: perSecond,
				},
				{
					label: "Errors",
					key: "errorThroughput",
					color: color("error"),
					dashed: true,
					format: perSecond,
				},
			]
		case "ErrorRate":
			return [
				{
					label: "Error rate",
					key: "errorRate",
					color: color("error"),
					dashed: false,
					format: formatErrorRate,
				},
			]
		case "Latency":
			return [
				{
					label: "P99",
					key: "p99LatencyMs",
					color: color("p99"),
					dashed: false,
					format: formatLatency,
				},
				{
					label: "P95",
					key: "p95LatencyMs",
					color: color("p95"),
					dashed: false,
					format: formatLatency,
				},
				{
					label: "P50",
					key: "p50LatencyMs",
					color: color("p50"),
					dashed: false,
					format: formatLatency,
				},
			]
	}
}

/** Throughput's rows: per-second volume and the error volume it derives (`errorRate` is a fraction). */
const rowsOf = (spec: BenchSpec, bucketSeconds: number | undefined): ReadonlyArray<Row> =>
	spec.chart !== "Throughput"
		? spec.rows
		: spec.rows.map((row) => {
				const throughput = numberOf(row, "throughput") / (bucketSeconds || 1)
				return { ...row, throughput, errorThroughput: throughput * numberOf(row, "errorRate") }
			})

/** The y domain and tick format: throughput and latency from 0 to the peak, nice; error rate clamped. */
const yOf = (spec: BenchSpec, rows: ReadonlyArray<Row>, rateLabel: string) => {
	const peak = (key: string) => rows.reduce((max, row) => Math.max(max, numberOf(row, key)), 0)
	switch (spec.chart) {
		case "Throughput":
			return yScale([0, peak("throughput")], (value) => formatThroughput(value, rateLabel), true)
		case "ErrorRate": {
			const domain = [0, Math.min(1, Math.max(peak("errorRate") * 1.2, 0.01))] as const
			return yScale(domain, axisTickFormatter("percent", domain), false)
		}
		case "Latency": {
			const domain = niceLinearDomain([0, peak("p99LatencyMs")])
			return yScale(domain, axisTickFormatter("duration_ms", domain), true)
		}
	}
}

export const buildBenchOverview = (spec: BenchSpec): BuiltChart<Row, ChartValue, number> => {
	const bucketSeconds = inferBucketSeconds(spec.rows.map((row) => ({ bucket: bucketOf(row) })))
	const axisContext = {
		rangeMs: inferRangeMs(spec.rows.map((row) => ({ bucket: bucketOf(row) }))),
		bucketSeconds,
	}
	const rateLabel = "/s"
	const rows = rowsOf(spec, bucketSeconds)
	const series = seriesOf(spec, rateLabel)
	const chrome = { border: spec.colors["border"] ?? "", background: spec.colors["background"] ?? "" }
	const x = (row: Row) => bucketOf(row)
	const y = (key: string) => (row: Row) => numberOf(row, key)
	const isArea = spec.chart !== "Latency"
	const lead = series[0]
	const marks = [
		...(isArea && lead !== undefined
			? [
					areaY(rows, {
						id: `${lead.key}Area`,
						x,
						y: y(lead.key),
						fill: `url(#${spec.gradientId})`,
						stroke: "none",
					}),
				]
			: []),
		...series.map((entry) =>
			entry.dashed
				? lineY(rows, {
						id: entry.key,
						x,
						y: y(entry.key),
						stroke: entry.color,
						strokeWidth: 1.5,
						strokeDasharray: "3 3",
					})
				: lineY(rows, { id: entry.key, x, y: y(entry.key), stroke: entry.color, strokeWidth: 2 }),
		),
		...series.map((entry) => focusDot(rows, x, y(entry.key), entry.color, chrome)),
		focusCrosshair(chrome),
	]
	return {
		definition: defineChart({
			gradients: isArea && lead !== undefined ? [verticalGradient(spec.gradientId, lead.color)] : [],
			marks,
			scales: { x: xScale(axisContext), y: yOf(spec, rows, rateLabel) },
			focus: "group-x",
			focusRing: false,
			// TODO(tooltip-anchor): anchor the card on the focus store; it follows the pointer.
			tooltip: cursorTooltip("pointer"),
		}),
		focusKeyOf: (point) => bucketOf(point.datum),
		tooltipOf: (points) =>
			Option.map(Option.fromNullishOr(points[0]), ({ datum }) =>
				ChartTooltip.Bucket({
					heading: formatBucketLabel(bucketOf(datum), axisContext, "tooltip"),
					rows: series.map((entry) => ({
						label: entry.label,
						color: entry.color,
						dashed: entry.dashed,
						value: entry.format(numberOf(datum, entry.key)),
					})),
				}),
			),
	}
}
