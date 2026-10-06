import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import { Result } from "@/lib/effect-atom"
import { ResultView } from "@/components/common/result-view"
import { Delta } from "@maple/ui/components/ui/delta"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatRail, StatRailItem, StatRailLoading } from "@/components/common/stat-rail"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { ServiceUsageResponse, ServiceUsageTotals } from "@/api/warehouse/service-usage"
import { normalizeTimestampInput } from "@/lib/timezone-format"

import { formatWarehouseDateTime } from "@maple/query-engine"

type CardKey = "logs" | "traces" | "metrics" | "dataSize"

const cardConfig: Array<{
	title: string
	key: CardKey
	format: (n: number) => string
}> = [
	{ title: "Total Logs", key: "logs", format: formatNumber },
	{ title: "Total Traces", key: "traces", format: formatNumber },
	{ title: "Total Metrics", key: "metrics", format: formatNumber },
	{ title: "Data Size", key: "dataSize", format: formatStorageBytes },
]

interface ServiceUsageCardsProps {
	startTime?: string
	endTime?: string
}

/** Sums per-service usage into one total per signal. */
export function sumTotals(response: ServiceUsageResponse): ServiceUsageTotals {
	return response.data.reduce(
		(acc, service) => ({
			logs: acc.logs + service.totalLogs,
			traces: acc.traces + service.totalTraces,
			metrics: acc.metrics + service.totalMetrics,
			dataSize: acc.dataSize + service.dataSizeBytes,
		}),
		{ logs: 0, traces: 0, metrics: 0, dataSize: 0 },
	)
}

function shiftRangeBack(startTime?: string, endTime?: string) {
	if (!startTime || !endTime) return { startTime: undefined, endTime: undefined }
	const start = new Date(normalizeTimestampInput(startTime))
	const end = new Date(normalizeTimestampInput(endTime))
	if (Number.isNaN(start.getTime()) || Number.isNaN(end.getTime())) {
		return { startTime: undefined, endTime: undefined }
	}
	const duration = end.getTime() - start.getTime()
	const prevEnd = new Date(start.getTime())
	const prevStart = new Date(start.getTime() - duration)
	return {
		startTime: formatWarehouseDateTime(prevStart.getTime()),
		endTime: formatWarehouseDateTime(prevEnd.getTime()),
	}
}

export function ServiceUsageCards({ startTime, endTime }: ServiceUsageCardsProps = {}) {
	// Current + previous totals come back in ONE request (sumIf over the union
	// window) instead of two separate per-period queries.
	const { startTime: prevStart, endTime: prevEnd } = shiftRangeBack(startTime, endTime)
	const responseResult = useRefreshableAtomValue(
		getServiceUsageResultAtom({
			data: { startTime, endTime, previousStartTime: prevStart, previousEndTime: prevEnd },
		}),
	)

	const previousTotals = Result.builder(responseResult)
		.onSuccess((r) => r.previousTotals ?? null)
		.orElse(() => null as null | ServiceUsageTotals)

	return (
		<ResultView
			result={responseResult}
			loading={<StatRailLoading />}
			// Quiet absence, not four more error blocks: the chart panels below
			// already carry the full message.
			error={() => (
				<StatRail>
					{cardConfig.map((card) => (
						<StatRailItem
							key={card.key}
							eyebrow={card.title}
							value="—"
							subline="Couldn't load"
							compact
						/>
					))}
				</StatRail>
			)}
		>
			{(response) => {
				const totals = sumTotals(response)
				return (
					<StatRail>
						{cardConfig.map((card) => {
							const current = totals[card.key]
							const previous = previousTotals?.[card.key]
							return (
								<StatRailItem
									key={card.key}
									eyebrow={card.title}
									value={card.format(current)}
									compact
									delta={
										previous !== undefined ? (
											<Delta current={current} previous={previous} suffix="vs prev" />
										) : (
											<Skeleton className="h-3 w-16" />
										)
									}
								/>
							)
						})}
					</StatRail>
				)
			}}
		</ResultView>
	)
}
