import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatNumber } from "@maple/ui/lib/format"
import { useAtomValue, useAtomRefresh } from "@/lib/effect-atom"

import { ResultView } from "@/components/common/result-view"
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

	return (
		<ResultView
			result={summaryResult}
			loading={<StatRailLoading />}
			errorVariant="inline"
			errorTitle="Failed to load metrics summary"
			onRetry={refreshSummary}
		>
			{(response, { waiting }) => {
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
					<StatRail className={refreshingClass(waiting)}>
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
			}}
		</ResultView>
	)
}
