import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import {
	CHART_EMPTY_MESSAGE,
	CHART_HEIGHT,
	ChartCard,
	ChartCardMessage,
} from "@/components/common/chart-card"
import { SeriesLegend } from "@/components/common/series-legend"
import { ChartLineIcon } from "@/components/icons"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"

import { InfraMetricChart } from "../primitives/infra-metric-chart"
import {
	gcpBuckets,
	gcpChartMetric,
	gcpClassRows,
	gcpLineRows,
	type GcpBucketPoint,
	type GcpChart,
	type GcpChartWindow,
} from "./charts"

/**
 * The charts of one timeseries read on a shared time axis and hover cursor. Each card links its
 * metric into the metrics explorer, narrowed by `where` to the workload.
 */
export function GcpWorkloadCharts({
	charts,
	points,
	range,
	where,
	timeSearch,
}: {
	charts: ReadonlyArray<GcpChart>
	points: ReadonlyArray<GcpBucketPoint>
	range: GcpChartWindow
	/** The metrics explorer filter that selects this workload's series. */
	where: string
	timeSearch: TimeRangeSearch
}) {
	const { containerProps } = useLinkedCursor(true)
	const { startTime, endTime, bucketSeconds } = range
	const rows = useMemo(() => {
		const window = { startTime, endTime, bucketSeconds }
		return charts.map((chart) =>
			chart.kind === "classes"
				? gcpClassRows(chart.metric, points, window)
				: gcpLineRows(chart.series, points, window),
		)
	}, [charts, points, startTime, endTime, bucketSeconds])
	// Every bucket of the read, also the ones the workload was silent in: see `gcpBuckets`.
	const xDomain = useMemo(
		() => gcpBuckets(points, bucketSeconds).map(({ bucket }) => bucket),
		[points, bucketSeconds],
	)

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2" {...containerProps}>
			{charts.map((chart, index) => {
				const metric = gcpChartMetric(chart, points)
				const explore = (
					<Link
						to="/metrics/$metricName"
						params={{ metricName: metric.name }}
						search={{ ...timeSearch, type: metric.type, where, groupBy: metric.groupBy }}
						title={`Open ${metric.name} in the metrics explorer`}
						aria-label={`Open ${metric.name} in the metrics explorer`}
						className="text-muted-foreground/60 transition-colors hover:text-foreground"
					>
						<ChartLineIcon size={12} />
					</Link>
				)
				if (rows[index].length === 0) {
					return (
						<ChartCard key={chart.title} title={chart.title} scope={explore}>
							<ChartCardMessage>{chart.note ?? CHART_EMPTY_MESSAGE}</ChartCardMessage>
						</ChartCard>
					)
				}
				// The legend sits in the card's header, so every plot in a row starts at the same
				// height. One line needs none, the title names it, unless it is one class of several.
				const names = [...new Set(rows[index].map((row) => row.attributeValue))]
				const colors = resolveSeriesColors(names)
				return (
					<ChartCard
						key={chart.title}
						title={chart.title}
						scope={explore}
						legend={
							names.length > 1 || chart.kind === "classes" ? (
								<SeriesLegend
									swatch="line"
									items={names.map((name) => ({
										key: name,
										label: name,
										color: colors.get(name),
									}))}
								/>
							) : undefined
						}
					>
						<InfraMetricChart
							rows={rows[index]}
							unit={chart.kind === "classes" ? "rate" : chart.unit}
							showThreshold={chart.kind === "lines" && chart.threshold}
							xDomain={xDomain}
							gaps
							linkedChartId={`gcp-${chart.title}`}
							height={CHART_HEIGHT}
						/>
					</ChartCard>
				)
			})}
		</div>
	)
}
