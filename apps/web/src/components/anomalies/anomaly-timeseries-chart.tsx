import { EmptyMessage } from "@maple/ui/components/ui/empty"
import * as React from "react"
import { areaY, d3Curve, defineChart, lineY, rect } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import type { AnomalyIncidentDocument, AnomalyIncidentTimeseriesResponse } from "@maple/domain/http"
import {
	CursorPlot,
	DASHED_Y_GRID,
	bucketDate,
	focusCrosshair,
	focusDot,
	makeBucketAxis,
	thresholdRules,
	useChartId,
	useCursorPlot,
	verticalGradient,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"
import { cn } from "@maple/ui/lib/utils"

import { SeriesLegend } from "@/components/common/series-legend"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

import { formatSignalValue } from "./anomaly-format"

/** The observed line's colour, by incident severity. */
const SEVERITY_STROKE = {
	critical: "--severity-error",
	warning: "--severity-warn",
} satisfies Record<"critical" | "warning", string>

/** One bucket of the observed signal. */
interface SignalPoint {
	bucket: string
	value: number
}

export function AnomalyTimeseriesChart({
	incident,
	timeseries,
	className,
}: {
	incident: AnomalyIncidentDocument
	timeseries: AnomalyIncidentTimeseriesResponse
	className?: string
}) {
	const { signalType, baselineMedian, thresholdValue } = timeseries
	const gradientId = useChartId("anomaly-observed")

	const valueFormatter = React.useCallback(
		(value: number) => formatSignalValue(signalType, Number.isFinite(value) ? value : 0),
		[signalType],
	)
	const series = React.useMemo<CursorPlotSeries<SignalPoint>[]>(
		() => [
			{
				key: "observed",
				label: "Observed",
				color: SEVERITY_STROKE[incident.severity],
				value: (point: SignalPoint) => point.value,
				format: valueFormatter,
			},
		],
		[incident.severity, valueFormatter],
	)
	const plot = useCursorPlot(series)
	const stroke = plot.color("observed")

	const data = React.useMemo<SignalPoint[]>(
		() =>
			[...timeseries.buckets]
				.sort((a, b) => Date.parse(a.bucket) - Date.parse(b.bucket))
				.map((b) => ({ bucket: b.bucket, value: b.value })),
		[timeseries.buckets],
	)

	const { effectiveTimezone } = useTimezonePreference()
	const axis = React.useMemo(
		() =>
			makeBucketAxis(
				data.map((point) => point.bucket),
				effectiveTimezone,
			),
		[data, effectiveTimezone],
	)

	// Snap the incident window to actual bucket values so the shading lines up
	// with the plotted points.
	const window = React.useMemo(() => {
		if (data.length === 0) return null
		const startMs = Date.parse(incident.firstTriggeredAt)
		const endMs = incident.resolvedAt !== null ? Date.parse(incident.resolvedAt) : Infinity
		let x1: string | null = null
		let x2: string | null = null
		for (const point of data) {
			const t = Date.parse(point.bucket)
			if (t >= startMs && x1 === null) x1 = point.bucket
			if (t <= endMs) x2 = point.bucket
		}
		// Window starts after the last bucket (fresh incident): pin to the edge.
		if (x1 === null) x1 = data[data.length - 1]!.bucket
		if (x2 === null || Date.parse(x2) < Date.parse(x1)) x2 = x1
		return { x1: bucketDate(x1), x2: bucketDate(x2) }
	}, [data, incident.firstTriggeredAt, incident.resolvedAt])

	// Pad the y-domain so both reference lines stay visible. Also the band's
	// vertical extent: a `rect` needs both edges, unlike `ReferenceArea`.
	const yDomain = React.useMemo<[number, number]>(() => {
		let maxVal = Math.max(thresholdValue, baselineMedian)
		for (const point of data) maxVal = Math.max(maxVal, point.value)
		return [0, maxVal * 1.15]
	}, [data, thresholdValue, baselineMedian])

	const definition = React.useMemo(() => {
		const at = (point: SignalPoint) => bucketDate(point.bucket)
		const value = (point: SignalPoint) => point.value

		return defineChart({
			gradients: [verticalGradient(gradientId, stroke, 0.3, 0.03)],
			marks: [
				// The incident window. `decorative` so the shading never takes the
				// pointer away from the series underneath it.
				...(window
					? [
							decorative(
								rect([window], {
									x1: (w: { x1: Date; x2: Date }) => w.x1,
									x2: (w: { x1: Date; x2: Date }) => w.x2,
									y1: () => yDomain[0],
									y2: () => yDomain[1],
									fill: stroke,
									fillOpacity: 0.06,
									stroke: "none",
								}),
							),
						]
					: []),
				// Baseline and threshold, as labelled rules. `labelX` anchors both at
				// the last bucket, which is where `insideTopRight` put them.
				...thresholdRules(
					[
						{
							value: baselineMedian,
							color: "--muted-foreground",
							label: "Baseline",
						},
						{ value: thresholdValue, color: "--severity-error", label: "Threshold" },
					],
					{ labelX: axis.domainMs ? new Date(axis.domainMs[1]) : undefined },
				),
				areaY(data, {
					x: at,
					y: value,
					y1: () => yDomain[0],
					fill: `url(#${gradientId})`,
					stroke: "none",
					curve: d3Curve(curveMonotoneX),
				}),
				lineY(data, {
					x: at,
					y: value,
					stroke,
					strokeWidth: 2,
					curve: d3Curve(curveMonotoneX),
				}),
				focusDot(data, at, value, stroke, plot.chrome),
				focusCrosshair(plot.chrome),
			],
			scales: {
				x: axis.x,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: { line: false, ticks: { size: 0, padding: 8, format: valueFormatter } },
				},
			},
			// `bottom` is left unset: an authored side is a hard lock, and `bottom: 0`
			// (carried over from Recharts, which sized the axis separately) clipped
			// the x tick labels out and halved the y axis's "0". Unset, the frame
			// measures the labels and reserves their height.
			margin: { top: 8, right: 8, left: 70 },
			focus: "group-x",
			focusRing: false,
			tooltip: plot.tooltip,
		})
	}, [
		data,
		window,
		yDomain,
		stroke,
		plot,
		gradientId,
		baselineMedian,
		thresholdValue,
		axis,
		valueFormatter,
	])

	if (data.length === 0) {
		return (
			<EmptyMessage
				dashed
				className={cn(
					"flex h-64 w-full items-center justify-center border-border/50 py-0 text-xs",
					className,
				)}
			>
				No signal data in window
			</EmptyMessage>
		)
	}

	return (
		<div className={cn("space-y-2", className)}>
			<CursorPlot
				plot={plot}
				definition={definition}
				series={series}
				heading={(point: SignalPoint) => axis.heading(point.bucket)}
				ariaLabel="Observed signal"
				className="h-64 w-full"
			/>
			<SeriesLegend
				className="justify-start gap-x-4"
				items={[
					{ key: "observed", label: "Observed", color: stroke, swatch: "line" },
					{
						key: "baseline",
						label: "Baseline median",
						value: formatSignalValue(signalType, baselineMedian),
						color: "var(--muted-foreground)",
					},
					{
						key: "threshold",
						label: "Threshold",
						value: formatSignalValue(signalType, thresholdValue),
						color: "var(--severity-error)",
					},
				]}
				swatch="dashed"
			/>
		</div>
	)
}
