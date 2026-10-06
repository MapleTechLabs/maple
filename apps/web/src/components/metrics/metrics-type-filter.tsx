import { Option } from "effect"
import * as AsyncResult from "effect/reactivity/AsyncResult"
import { formatNumber } from "@maple/ui/lib/format"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "@maple/ui/components/ui/select"
import { useAtomValue } from "@/lib/effect-atom"

import { type ListMetricsInput } from "@/api/warehouse/metrics"
import { getMetricsSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

export type MetricType = NonNullable<ListMetricsInput["metricType"]>

const ITEMS: ReadonlyArray<{ value: MetricType | "all"; label: string }> = [
	{ value: "all", label: "All types" },
	{ value: "sum", label: "Sum" },
	{ value: "gauge", label: "Gauge" },
	{ value: "histogram", label: "Histogram" },
	{ value: "exponential_histogram", label: "Exp histogram" },
]

/**
 * The metric-type pivot; counts live in the menu so the toolbar stays a single quiet control.
 * Counts are informational only: the summary can be stale or lag the results, so a zero never blocks a type.
 */
export function MetricsTypeFilter({
	value,
	onChange,
	startTime,
	endTime,
}: {
	value: MetricType | null
	onChange: (type: MetricType | null) => void
	startTime?: string
	endTime?: string
}) {
	const summaryResult = useAtomValue(getMetricsSummaryResultAtom({ data: { startTime, endTime } }))
	// Counts are decoration: a loading or failed summary still leaves the filter usable.
	const summary = Option.getOrNull(AsyncResult.value(summaryResult))?.data ?? null
	const countOf = (type: MetricType | "all") =>
		summary === null
			? undefined
			: type === "all"
				? summary.reduce((acc, row) => acc + row.metricCount, 0)
				: (summary.find((row) => row.metricType === type)?.metricCount ?? 0)
	const dataPointsOf = (type: MetricType | "all") =>
		type === "all"
			? summary?.reduce((acc, row) => acc + row.dataPointCount, 0)
			: summary?.find((row) => row.metricType === type)?.dataPointCount

	return (
		<Select
			items={ITEMS}
			value={value ?? "all"}
			onValueChange={(next) => {
				const picked = ITEMS.find((item) => item.value === next)?.value
				onChange(picked === undefined || picked === "all" ? null : picked)
			}}
		>
			<SelectTrigger size="sm" className="w-auto min-w-0 text-xs" aria-label="Metric type">
				<SelectValue />
			</SelectTrigger>
			<SelectContent>
				{ITEMS.map((item) => {
					const count = countOf(item.value)
					const dataPoints = dataPointsOf(item.value)
					return (
						<SelectItem key={item.value} value={item.value}>
							<span
								className="flex w-full items-center justify-between gap-6"
								title={
									dataPoints !== undefined ? `${formatNumber(dataPoints)} data points` : undefined
								}
							>
								{item.label}
								{count !== undefined && (
									<span className="text-muted-foreground tabular-nums">{count}</span>
								)}
							</span>
						</SelectItem>
					)
				})}
			</SelectContent>
		</Select>
	)
}
