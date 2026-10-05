import { formatNumber } from "@maple/ui/lib/format"
import { Result, useAtomValue, useAtomRefresh } from "@/lib/effect-atom"

import { ErrorState } from "@/components/common/error-state"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { type ListMetricsInput } from "@/api/warehouse/metrics"
import { getMetricsSummaryResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"

export type MetricType = ListMetricsInput["metricType"]

const cardConfig = [
	{ title: "Sum Metrics", key: "sum" as const },
	{ title: "Gauge Metrics", key: "gauge" as const },
	{ title: "Histogram", key: "histogram" as const },
	{ title: "Exp Histogram", key: "exponential_histogram" as const },
]

interface MetricsSummaryCardsProps {
	selectedType: MetricType | null
	onSelectType: (type: MetricType | null) => void
	startTime?: string
	endTime?: string
}

export function MetricsSummaryCards({
	selectedType,
	onSelectType,
	startTime,
	endTime,
}: MetricsSummaryCardsProps) {
	const summaryAtom = getMetricsSummaryResultAtom({ data: { startTime, endTime } })
	const summaryResult = useAtomValue(summaryAtom)
	const refreshSummary = useAtomRefresh(summaryAtom)

	return Result.builder(summaryResult)
		.onInitial(() => <StatRailLoading />)
		.onError((error) => (
			<ErrorState
				variant="inline"
				error={error}
				title="Failed to load metrics summary"
				onRetry={refreshSummary}
			/>
		))
		.onSuccess((response, result) => {
			const summaryByType = response.data.reduce(
				(acc, item) => {
					acc[item.metricType] = {
						metricCount: item.metricCount,
						dataPointCount: item.dataPointCount,
					}
					return acc
				},
				{} as Record<string, { metricCount: number; dataPointCount: number }>,
			)

			return (
				<StatRail className={result.waiting ? "opacity-60" : undefined}>
					{cardConfig.map((card) => {
						const data = summaryByType[card.key]
						const isSelected = selectedType === card.key
						return (
							<StatRailItem
								key={card.key}
								eyebrow={card.title}
								value={formatNumber(data?.dataPointCount ?? 0)}
								subline={`${data?.metricCount ?? 0} unique metrics`}
								compact
								selected={isSelected}
								onSelect={() => onSelectType(isSelected ? null : card.key)}
							/>
						)
					})}
				</StatRail>
			)
		})
		.render()
}
