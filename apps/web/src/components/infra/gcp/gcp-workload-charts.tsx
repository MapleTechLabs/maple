import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import {
	CHART_EMPTY_MESSAGE,
	CHART_HEIGHT,
	ChartCard,
	ChartCardMessage,
} from "@/components/common/chart-card"
import { SeriesLegend } from "@/components/common/series-legend"
import { ChartLineIcon } from "@/components/icons"
import { appendWhereFilter } from "@/components/metrics/metric-breakdown"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"

import { STATUS_CLASS_COLORS, STATUS_CLASS_ORDER } from "../cloudflare/constants"
import { StackedBreakdownChart } from "../cloudflare/cloudflare-zone-detail-charts"
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

/** Response classes, and the outcomes of an execution and of a push, in the same severity colors. */
const CLASS_COLORS = {
	...STATUS_CLASS_COLORS,
	ok: STATUS_CLASS_COLORS["2xx"],
	ack: STATUS_CLASS_COLORS["2xx"],
	error: STATUS_CLASS_COLORS["5xx"],
}

/**
 * The charts of one timeseries read on a shared time axis and hover cursor. Each card links its
 * metric into the metrics explorer, narrowed to `serviceName`.
 */
export function GcpWorkloadCharts({
	charts,
	points,
	range,
	serviceName,
	timeSearch,
}: {
	charts: ReadonlyArray<GcpChart>
	points: ReadonlyArray<GcpBucketPoint>
	range: GcpChartWindow
	/** The `service.name` the workload's metrics are stored under. */
	serviceName: string
	timeSearch: TimeRangeSearch
}) {
	const { containerProps } = useLinkedCursor(true)
	const { startTime, endTime, bucketSeconds } = range
	const rows = useMemo(
		() =>
			charts.map((chart) =>
				chart.kind === "classes"
					? gcpClassRows(chart.metric, points)
					: gcpLineRows(chart.series, points, { startTime, endTime, bucketSeconds }),
			),
		[charts, points, startTime, endTime, bucketSeconds],
	)
	// Every bucket of the read, so a chart whose metric started late still spans the same axis.
	const xDomain = useMemo(() => gcpBuckets(points).map(({ bucket }) => bucket), [points])

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2" {...containerProps}>
			{charts.map((chart, index) => {
				const metric = gcpChartMetric(chart, points)
				const explore = (
					<Link
						to="/metrics/$metricName"
						params={{ metricName: metric.name }}
						search={{
							...timeSearch,
							type: metric.type,
							where: appendWhereFilter("", "service.name", serviceName),
						}}
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
				if (chart.kind === "classes") {
					return (
						<StackedBreakdownChart
							key={chart.title}
							title={chart.title}
							rows={rows[index]}
							colors={CLASS_COLORS}
							order={STATUS_CLASS_ORDER}
							syncId="gcp-workload"
							scope={explore}
						/>
					)
				}
				// The legend sits in the card's header, as on the stacked cards, so every plot in a
				// row starts at the same height. One line needs none: the title names it.
				const names = [...new Set(rows[index].map((row) => row.attributeValue))]
				const colors = resolveSeriesColors(names)
				return (
					<ChartCard
						key={chart.title}
						title={chart.title}
						scope={explore}
						legend={
							names.length > 1 ? (
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
							unit={chart.unit}
							showThreshold={chart.threshold}
							xDomain={xDomain}
							linkedChartId={`gcp-${chart.title}`}
							height={CHART_HEIGHT}
						/>
					</ChartCard>
				)
			})}
		</div>
	)
}
