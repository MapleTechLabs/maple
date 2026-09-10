import { useMemo } from "react"

import {
	QueryBuilderAreaChart,
	QueryBuilderBarChart,
	QueryBuilderLineChart,
} from "@maple/ui/components/charts"
import { QueryBuilderHbarChart } from "@maple/ui/components/charts/hbar/query-builder-hbar-chart"

import { rankedRows, timeseriesRows, type ChartSpec } from "./chart-spec"

/**
 * The plot behind a ```chart fence, split out so `markdown-chart.tsx` can load
 * it lazily — a transcript with no chart in it never pulls in the plotting
 * runtime.
 *
 * `legend="hidden"` throughout: nothing opens a legend slot in a 420px chat
 * column, so the series are identified by the tooltip, the way the chart a tool
 * result embeds already is.
 */
export function ChartPlot({ spec, unit, className }: { spec: ChartSpec; unit: string; className?: string }) {
	const rows = useMemo(
		() => (spec.type === "ranked" ? rankedRows(spec.data) : timeseriesRows(spec.data)),
		[spec],
	)

	switch (spec.type) {
		case "ranked":
			return <QueryBuilderHbarChart data={rows} unit={unit} className={className} />
		case "bar":
			return <QueryBuilderBarChart data={rows} unit={unit} legend="hidden" className={className} />
		case "area":
			return (
				<QueryBuilderAreaChart
					data={rows}
					unit={unit}
					legend="hidden"
					curveType="monotone"
					className={className}
				/>
			)
		case "line":
			return (
				<QueryBuilderLineChart
					data={rows}
					unit={unit}
					legend="hidden"
					curveType="monotone"
					className={className}
				/>
			)
	}
}
