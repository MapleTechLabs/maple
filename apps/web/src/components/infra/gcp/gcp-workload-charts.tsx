import { useMemo } from "react"
import { Link } from "@tanstack/react-router"

import { ChartEmpty } from "@maple/ui/components/charts"

import { CHART_EMPTY_MESSAGE, CHART_HEIGHT, ChartCard } from "@/components/common/chart-card"
import { SeriesLegend } from "@/components/common/series-legend"
import { ChartLineIcon } from "@/components/icons"
import { appendWhereFilter } from "@/components/metrics/metric-breakdown"
import type { TimeRangeSearch } from "@/components/time-range-picker/search"
import { useLinkedCursor } from "@/hooks/use-linked-cursor"

import { formatValueWithUnit } from "../chart-utils"
import { STATUS_CLASS_COLORS, STATUS_CLASS_ORDER } from "../cloudflare/constants"
import { StackedBreakdownChart } from "../cloudflare/cloudflare-zone-detail-charts"
import { InfraMetricChart, type InfraSeriesInfo } from "../primitives/infra-metric-chart"
import { gcpChartMetric, gcpClassRows, gcpLineRows, type GcpBucketPoint, type GcpChart } from "./charts"

/** Response classes, and the outcomes of an execution and of a push, in the same severity colors. */
const CLASS_COLORS = {
	...STATUS_CLASS_COLORS,
	ok: STATUS_CLASS_COLORS["2xx"],
	ack: STATUS_CLASS_COLORS["2xx"],
	error: STATUS_CLASS_COLORS["5xx"],
}

/** The latest value of each line, above a plot with more than one. */
function SeriesSummary({ series, colors, lastValues, unit }: InfraSeriesInfo) {
	if (series.length < 2) return null
	return (
		<SeriesLegend
			swatch="line"
			className="justify-start px-3 pb-1"
			items={series.map((name) => {
				const value = lastValues[name]
				return {
					key: name,
					label: name,
					color: colors.get(name),
					value: value === undefined ? undefined : formatValueWithUnit(value, unit),
				}
			})}
		/>
	)
}

/**
 * One workload's charts on a shared time axis and hover cursor. Each card links its metric into
 * the metrics explorer, narrowed to `serviceName`.
 */
export function GcpWorkloadCharts({
	charts,
	points,
	bucketSeconds,
	xDomain,
	serviceName,
	timeSearch,
	waiting,
}: {
	charts: ReadonlyArray<GcpChart>
	points: ReadonlyArray<GcpBucketPoint>
	bucketSeconds: number
	/** Every bucket on the page, so charts read from different queries share one axis. */
	xDomain: ReadonlyArray<string>
	serviceName: string
	timeSearch: TimeRangeSearch
	waiting: boolean
}) {
	const { containerProps } = useLinkedCursor(true)
	const rows = useMemo(
		() =>
			charts.map((chart) =>
				chart.kind === "classes"
					? gcpClassRows(chart.metric, points)
					: gcpLineRows(chart.series, points, bucketSeconds),
			),
		[charts, points, bucketSeconds],
	)

	return (
		<div className="grid grid-cols-1 gap-4 lg:grid-cols-2" {...containerProps}>
			{charts.map((chart, index) => {
				const metric = gcpChartMetric(chart)
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
							<ChartEmpty height={CHART_HEIGHT}>{chart.note ?? CHART_EMPTY_MESSAGE}</ChartEmpty>
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
				return (
					<ChartCard key={chart.title} title={chart.title} scope={explore}>
						<InfraMetricChart
							rows={rows[index]}
							unit={chart.unit}
							showThreshold={chart.threshold}
							xDomain={xDomain}
							linkedChartId={`gcp-${chart.title}`}
							header={SeriesSummary}
							height={CHART_HEIGHT}
							waiting={waiting}
						/>
					</ChartCard>
				)
			})}
		</div>
	)
}
