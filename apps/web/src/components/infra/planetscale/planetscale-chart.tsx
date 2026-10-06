import { useMemo, type ReactNode } from "react"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { d3Curve, defineChart, lineY } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import {
	CursorPlot,
	DASHED_Y_GRID,
	bucketDate,
	focusCrosshair,
	focusDot,
	linearYDomain,
	makeBucketAxis,
	niceLinearDomain,
	useCursorPlot,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"
import { ChartLoading } from "@maple/ui/components/charts"
import { cn } from "@maple/ui/lib/utils"

import type { PlanetScaleInfraTimeseriesRow } from "@/api/warehouse/planetscale-infra"
import { formatNumber } from "@maple/ui/lib/format"
import {
	chartEventMarkerMarks,
	placeMarkersInWindow,
	type ChartEventMarker,
} from "../primitives/chart-event-markers"
import { formatPercent } from "@maple/ui/lib/format"
import { CHART_EMPTY_MESSAGE, CHART_HEIGHT, ChartCard, ChartCardMessage } from "@/components/common/chart-card"
import { formatLag, formatStoragePercent } from "./metrics"

export type PlanetScaleMetric =
	| "connectionsAvg"
	| "cpuMaxPercent"
	| "memMaxPercent"
	| "storageUsedPercent"
	| "replicaLagMaxSeconds"

const METRIC_LABELS: Record<PlanetScaleMetric, string> = {
	connectionsAvg: "Active connections",
	cpuMaxPercent: "CPU utilization (max)",
	memMaxPercent: "Memory utilization (max)",
	storageUsedPercent: "Storage used (max)",
	replicaLagMaxSeconds: "Replica lag (max)",
} satisfies Record<PlanetScaleMetric, string>

const METRIC_COLORS = {
	connectionsAvg: "--chart-1",
	cpuMaxPercent: "--chart-2",
	memMaxPercent: "--chart-3",
	storageUsedPercent: "--chart-5",
	replicaLagMaxSeconds: "--chart-4",
} satisfies Record<PlanetScaleMetric, string>

function formatMetricValue(value: number, metric: PlanetScaleMetric): string {
	if (metric === "cpuMaxPercent" || metric === "memMaxPercent") return formatPercent(value / 100)
	if (metric === "storageUsedPercent") return formatStoragePercent(value)
	if (metric === "replicaLagMaxSeconds") return formatLag(value)
	return formatNumber(value)
}

/** Percentages plot against a fixed 0–100 so a flat 94% disk still looks like 94%. */
const isPercentMetric = (metric: PlanetScaleMetric) =>
	metric === "cpuMaxPercent" || metric === "memMaxPercent" || metric === "storageUsedPercent"

export function PlanetScaleChartLoading({ metric }: { metric: PlanetScaleMetric }) {
	return (
		<ChartCard title={METRIC_LABELS[metric]} legend={null}>
			<ChartLoading variant="line" height={CHART_HEIGHT} className="px-3 pt-2 pb-3" />
		</ChartCard>
	)
}

/** One point: its bucket, the same as an instant, and the metric's value there (null = no sample). */
interface MetricPoint {
	bucket: string
	date: Date
	value: number | null
}

/** One single-series health chart for the /infra/planetscale database detail page. */
export function PlanetScaleChart({
	buckets,
	metric,
	waiting = false,
	scope,
	markers,
	emptyMessage,
	className,
}: {
	buckets: ReadonlyArray<PlanetScaleInfraTimeseriesRow>
	metric: PlanetScaleMetric
	waiting?: boolean
	scope?: ReactNode
	/** Deploys and branch events drawn onto the plot — what explains a cliff. */
	markers?: ReadonlyArray<ChartEventMarker>
	/** Overridden when the emptiness has a cause worth naming (metrics paused, say). */
	emptyMessage?: ReactNode
	className?: string
}) {
	const series = useMemo<CursorPlotSeries<MetricPoint>[]>(
		() => [
			{
				key: metric,
				label: METRIC_LABELS[metric],
				color: METRIC_COLORS[metric],
				value: (point: MetricPoint) => point.value,
				format: (value: number) => formatMetricValue(value, metric),
			},
		],
		[metric],
	)
	const plot = useCursorPlot(series)
	const color = plot.color(metric)

	const data = useMemo<MetricPoint[]>(
		() =>
			buckets.map((row) => ({ bucket: row.bucket, date: bucketDate(row.bucket), value: row[metric] })),
		[buckets, metric],
	)

	// A time axis over the buckets' instants — see `makeBucketAxis` for why the
	// label point scale this replaced folded a 24h window onto itself.
	const { effectiveTimezone } = useTimezonePreference()
	const axis = useMemo(
		() =>
			makeBucketAxis(
				buckets.map((row) => row.bucket),
				effectiveTimezone,
			),
		[buckets, effectiveTimezone],
	)

	// Markers sit at their own instant on that axis; only the window is decided
	// here — see chart-event-markers.
	const placed = useMemo(() => {
		if (markers === undefined || markers.length === 0) return []
		return placeMarkersInWindow(
			markers,
			buckets.map((row) => row.bucket),
		)
	}, [markers, buckets])

	// Storage can be null for buckets the volume gauges never reported. Those are
	// gaps in the line, not zeroes — but a series of only gaps is an empty chart.
	const hasValues = useMemo(() => data.some((point) => point.value !== null), [data])

	/**
	 * ONE domain, feeding both the axis and the event bands.
	 *
	 * A band is a `rect` and needs both edges, so it cannot discover the plot's
	 * extent the way Recharts' `ReferenceArea` did. Computing it here is what
	 * keeps the band flush with the axis instead of stopping wherever the data
	 * happened to end.
	 */
	const yDomain = useMemo<[number, number]>(() => {
		if (isPercentMetric(metric)) return [0, 100]
		return niceLinearDomain(
			linearYDomain({
				rows: data.map((point) => ({ value: point.value ?? 0 })),
				keys: ["value"],
			}),
		)
	}, [data, metric])

	const definition = useMemo(() => {
		const at = (point: MetricPoint) => point.date
		// A bucket with no sample is a hole in the data; bridging it would draw a
		// disk trend that never happened. `null` is what breaks the path — the
		// equivalent of Recharts' `connectNulls={false}`.
		const value = (point: MetricPoint) => point.value

		return defineChart({
			marks: [
				...chartEventMarkerMarks(placed, { yDomain }),
				lineY(data, {
					x: at,
					y: value,
					stroke: color,
					strokeWidth: 1.5,
					curve: d3Curve(curveMonotoneX),
				}),
				focusDot(data, at, value, color, plot.chrome),
				focusCrosshair(plot.chrome),
			],
			scales: {
				x: axis.x,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: {
							size: 0,
							padding: 8,
							format: (v: number) => formatMetricValue(v, metric),
						},
					},
				},
			},
			// A pinned left margin keeps this chart's plot aligned with its siblings
			// on the page, as `<YAxis width={52}>` did. `bottom` stays unset: a set
			// side is a hard lock, and only a measured side reserves the x labels.
			margin: { left: 52, top: 12, right: 12 },
			focus: "group-x",
			focusRing: false,
			tooltip: plot.tooltip,
		})
	}, [data, axis, placed, yDomain, color, plot, metric])

	return (
		<ChartCard
			title={METRIC_LABELS[metric]}
			legend={null}
			scope={scope}
			className={cn(refreshingClass(waiting), className)}
		>
			{!hasValues ? (
				<ChartCardMessage>{emptyMessage ?? CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<CursorPlot
					plot={plot}
					definition={definition}
					series={series}
					heading={(point: MetricPoint) => axis.heading(point.bucket)}
					ariaLabel={METRIC_LABELS[metric]}
					height={CHART_HEIGHT}
				/>
			)}
		</ChartCard>
	)
}
