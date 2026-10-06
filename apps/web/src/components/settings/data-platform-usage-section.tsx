import { EMPTY_VALUE, formatNumber, formatStorageBytes } from "@maple/ui/lib/format"
import type { ReactNode } from "react"
import { Result } from "@/lib/effect-atom"
import { DatabaseIcon, type IconComponent } from "@/components/icons"
import { CONCEPT_ICON } from "@/components/icons/concept"
import { cn } from "@maple/ui/lib/utils"
import { Skeleton } from "@maple/ui/components/ui/skeleton"
import { StatRail, StatRailItem } from "@/components/common/stat-rail"
import { getServiceUsageResultAtom } from "@/lib/services/atoms/warehouse-query-atoms"
import { useRefreshableAtomValue } from "@/hooks/use-refreshable-atom-value"
import { sumTotals } from "@/components/dashboard/service-usage-cards"
import { SettingsSection } from "@/components/settings/settings-section"

// "Total in the DB": sum every retained usage row for the org. Fixed bounds
// (not a rolling window) keep the atom key stable and capture all stored data.
const ALL_TIME = { startTime: "2000-01-01 00:00:00", endTime: "2099-12-31 23:59:59" }

type StatKey = "logs" | "traces" | "metrics" | "dataSize"

const STATS: ReadonlyArray<{
	key: StatKey
	label: string
	icon: IconComponent
	tone: string
	format: (n: number) => string
}> = [
	{ key: "logs", label: "Logs", icon: CONCEPT_ICON.log, tone: "text-chart-2", format: formatNumber },
	{
		key: "traces",
		label: "Traces",
		icon: CONCEPT_ICON.trace,
		tone: "text-chart-5",
		format: formatNumber,
	},
	{
		key: "metrics",
		label: "Metrics",
		icon: CONCEPT_ICON.metric,
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
		<SettingsSection
			title="Stored data"
			description="Everything currently held in the warehouse for this organization."
			framed={false}
		>
			<StatRail>
				{Result.builder(result)
					.onSuccess((response) => {
						const totals = sumTotals(response)
						return STATS.map((stat) => statItem(stat, stat.format(totals[stat.key])))
					})
					.onError(() =>
						STATS.map((stat) =>
							statItem(
								stat,
								<span className="text-sm text-muted-foreground">{EMPTY_VALUE}</span>,
							),
						),
					)
					.orElse(() =>
						STATS.map((stat) => statItem(stat, <Skeleton className="h-[26px] w-24" />)),
					)}
			</StatRail>
		</SettingsSection>
	)
}
