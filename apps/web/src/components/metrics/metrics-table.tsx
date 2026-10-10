import { cn } from "@maple/ui/lib/utils"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { formatNumber } from "@maple/ui/lib/format"
import { TableSkeleton } from "@maple/ui/components/ui/table-skeleton"
import { RelativeTime } from "@/components/common/relative-time"
import { useState } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"

import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@maple/ui/components/ui/table"
import { SignalEmptyState } from "@/components/common/signal-empty-state"
import { Badge } from "@maple/ui/components/ui/badge"
import { ListFooter } from "@maple/ui/components/ui/list-footer"
import { TruncatedText } from "@maple/ui/components/ui/truncated-text"
import { MetricTypeBadge } from "./metric-type-badge"
import { type Metric, type ListMetricsInput } from "@/api/warehouse/metrics"
import { listMetricsResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { ErrorState } from "@/components/common/error-state"
import { ServiceDot } from "@maple/ui/components/service-dot"

interface MetricsTableProps {
	search: string
	metricType: ListMetricsInput["metricType"] | null
	onOpenMetric: (metric: Metric) => void
	onClearFilters: () => void
	startTime?: string
	endTime?: string
}

const SKELETON_COLUMNS = [
	{ header: "Metric Name", headClassName: "w-[40%]", skeleton: "w-48" },
	{
		header: "Type",
		headClassName: "hidden md:table-cell w-[100px]",
		cellClassName: "hidden md:table-cell",
		skeleton: "w-16",
	},
	{
		header: "Service",
		headClassName: "hidden md:table-cell w-[120px]",
		cellClassName: "hidden md:table-cell",
		skeleton: "w-20",
	},
	{
		header: "Points",
		headClassName: "hidden md:table-cell w-[100px]",
		cellClassName: "hidden md:table-cell",
		skeleton: "w-12",
	},
	{
		header: "Last Seen",
		headClassName: "hidden md:table-cell w-[100px]",
		cellClassName: "hidden md:table-cell",
		skeleton: "w-16",
	},
]

function LoadingState() {
	return <TableSkeleton columns={SKELETON_COLUMNS} rows={10} tableClassName="table-fixed" />
}

const PAGE_SIZE = 100
// Backend rejects limit > 1000 (ListMetricsInputSchema); we request limit + 1
// to detect more pages, so the displayed cap is 999.
const MAX_LIMIT = 1000

export function MetricsTable({
	search,
	metricType,
	onOpenMetric,
	onClearFilters,
	startTime,
	endTime,
}: MetricsTableProps) {
	const [limit, setLimit] = useState(PAGE_SIZE)
	const requestLimit = Math.min(limit + 1, MAX_LIMIT)

	const metricsResult = useAtomValue(
		listMetricsResultAtom({
			data: {
				search: search || undefined,
				metricType: metricType || undefined,
				limit: requestLimit,
				startTime,
				endTime,
			},
		}),
	)

	// Each Load more swaps to a new atom (the limit is part of the query key),
	// which starts in its initial state. Keep the last successful page so the
	// table stays rendered (dimmed) while the next page loads.
	const [view, setView] = useState<{
		source: { data: Metric[] }
		metrics: Metric[]
		hasMore: boolean
	} | null>(null)
	if (Result.isSuccess(metricsResult) && view?.source !== metricsResult.value) {
		setView({
			source: metricsResult.value,
			metrics: metricsResult.value.data.slice(0, limit),
			hasMore: metricsResult.value.data.length > limit,
		})
	}

	if (Result.isFailure(metricsResult) || view === null) {
		return Result.builder(metricsResult)
			.onError((error) => <ErrorState error={error} />)
			.orElse(() => <LoadingState />)
	}

	const { metrics, hasMore } = view
	const waiting = !Result.isSuccess(metricsResult) || metricsResult.waiting

	return metrics.length === 0 ? (
		<SignalEmptyState
			signal="metrics"
			filtered={search !== "" || Boolean(metricType)}
			onClearFilters={onClearFilters}
		/>
	) : (
		<div className={cn("space-y-4", refreshingClass(waiting))} aria-busy={waiting || undefined}>
			<div className="rounded-md border overflow-auto">
				<Table className="table-fixed">
					<TableHeader>
						<TableRow>
							<TableHead className="w-[40%]">Metric Name</TableHead>
							<TableHead className="w-[100px]">Type</TableHead>
							<TableHead className="w-[120px]">Service</TableHead>
							<TableHead className="w-[100px]">Points</TableHead>
							<TableHead className="w-[100px]">Last Seen</TableHead>
						</TableRow>
					</TableHeader>
					<TableBody>
						{metrics.map((metric) => {
							return (
								<TableRow
									key={`${metric.metricName}-${metric.metricType}-${metric.serviceName}`}
									className="cursor-pointer hover:bg-muted/50 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring focus-visible:ring-inset"
									tabIndex={0}
									onClick={() => onOpenMetric(metric)}
									onKeyDown={(e) => {
										if (e.key === "Enter" || e.key === " ") {
											e.preventDefault()
											onOpenMetric(metric)
										}
									}}
								>
									<TableCell>
										<div className="flex min-w-0 flex-col gap-0.5">
											<TruncatedText
												text={metric.metricName}
												mono
												className="text-xs"
											/>
											{metric.metricDescription && (
												<span className="text-3xs text-muted-foreground line-clamp-1">
													{metric.metricDescription}
												</span>
											)}
										</div>
									</TableCell>
									<TableCell className="hidden md:table-cell">
										<MetricTypeBadge type={metric.metricType} />
									</TableCell>
									<TableCell className="hidden md:table-cell overflow-hidden">
										{metric.serviceName ? (
											<Badge
												variant="outline"
												size="xs"
												mono
												className="max-w-full"
												title={metric.serviceName}
											>
												<ServiceDot serviceName={metric.serviceName} size="sm" />
												<span className="min-w-0 truncate">{metric.serviceName}</span>
											</Badge>
										) : (
											<span className="text-xs text-muted-foreground">-</span>
										)}
									</TableCell>
									<TableCell className="hidden md:table-cell font-mono text-xs">
										{formatNumber(metric.dataPointCount)}
									</TableCell>
									<TableCell className="hidden md:table-cell text-xs text-muted-foreground">
										<RelativeTime value={metric.lastSeen} tooltip="title" />
									</TableCell>
								</TableRow>
							)
						})}
					</TableBody>
				</Table>
			</div>

			<ListFooter
				shown={metrics.length}
				noun="metrics"
				hasMore={hasMore}
				loading={waiting}
				onLoadMore={() => setLimit((current) => current + PAGE_SIZE)}
				align="start"
				className="justify-start p-0 text-sm"
			/>
		</div>
	)
}
