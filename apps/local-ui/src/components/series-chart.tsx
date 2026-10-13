// The one timeseries chart the detail pages share: pivot, gap handling and
// the loading / not-enough-data states live here, not in each view.

import { useMemo } from "react"
import { QueryBuilderLineChart } from "@maple/ui/components/charts/line/query-builder-line-chart"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"
import { pivotSeries, type GapFill, type SeriesPoint } from "../lib/chart-series"
import type { ChartWindow } from "../lib/time"

export function SeriesChart({
	points,
	window,
	fill,
	isPending,
	heightClassName = "h-56",
	unit,
	fitYAxisToData,
}: {
	points: ReadonlyArray<SeriesPoint> | undefined
	window: ChartWindow
	fill: GapFill
	isPending: boolean
	heightClassName?: string
	unit?: string
	fitYAxisToData?: boolean
}) {
	const rows = useMemo(() => pivotSeries(points ?? [], window, fill), [points, window, fill])

	if (isPending) {
		return (
			<div className={cn("flex items-center justify-center rounded-md border", heightClassName)}>
				<Spinner />
			</div>
		)
	}
	if (rows.length < 2) {
		return (
			<div
				className={cn(
					"flex items-center justify-center rounded-md border text-sm text-muted-foreground",
					heightClassName,
				)}
			>
				No datapoints in this range yet.
			</div>
		)
	}
	return (
		<div className="rounded-md border p-3">
			<QueryBuilderLineChart
				data={rows}
				className={cn(heightClassName, "w-full")}
				legend="visible"
				curveType="monotone"
				unit={unit}
				fitYAxisToData={fitYAxisToData}
			/>
		</div>
	)
}
