import { formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import type { ReactNode } from "react"
import { Result } from "@/lib/effect-atom"
import { ChartLineIcon, DatabaseIcon, FileIcon, GridSquareCirclePlusIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import type { ServiceUsageResponse } from "@/api/warehouse/service-usage"

// "Total in the DB": sum every retained usage row for the org. Fixed bounds
// (not a rolling window) keep the atom key stable and capture all stored data.
const ALL_TIME = { startTime: "2000-01-01 00:00:00", endTime: "2099-12-31 23:59:59" }

type StatKey = "logs" | "traces" | "metrics" | "dataSize"

const STATS: ReadonlyArray<{
	key: StatKey
	label: string
	icon: typeof FileIcon
	tone: string
	format: (n: number) => string
}> = [
	{ key: "logs", label: "Logs", icon: FileIcon, tone: "text-chart-2", format: formatNumber },
	{
		key: "traces",
		label: "Traces",
		icon: GridSquareCirclePlusIcon,
		tone: "text-chart-5",
		format: formatNumber,
	},
	{
		key: "metrics",
		label: "Metrics",
		icon: ChartLineIcon,
		tone: "text-chart-3",
		format: formatNumber,
	},
	{
		key: "dataSize",
		label: "Storage",
		icon: DatabaseIcon,
		tone: "text-chart-1",
		format: formatStorageBytes,
	},
]

function sumTotals(response: ServiceUsageResponse) {
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

function statItem(stat: (typeof STATS)[number], value: ReactNode) {
	const Icon = stat.icon
	return (
		<StatRailItem
			key={stat.key}
			compact
			eyebrow={stat.label}
			value={value}
			action={<Icon size={13} aria-hidden className={cn("shrink-0", stat.tone)} />}
		/>
	)
}

export function DataPlatformUsageSection() {
	const result = useRefreshableAtomValue(getServiceUsageResultAtom({ data: ALL_TIME }))

	return (
		<section className="space-y-3">
			<div className="space-y-0.5">
				<h2 className="font-display text-sm font-medium text-foreground">Stored data</h2>
				<p className="text-muted-foreground text-xs">
					Everything currently held in the warehouse for this organization.
				</p>
			</div>

			<StatRail>
				{Result.builder(result)
					.onSuccess((response) => {
						const totals = sumTotals(response)
						return STATS.map((stat) => statItem(stat, stat.format(totals[stat.key])))
					})
					.onError(() =>
						STATS.map((stat) =>
							statItem(stat, <span className="text-sm text-muted-foreground">—</span>),
						),
					)
					.orElse(() => STATS.map((stat) => statItem(stat, <Skeleton className="h-[26px] w-24" />)))}
			</StatRail>
		</section>
	)
}
