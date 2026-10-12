import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { HistoryIcon } from "@/components/icons"
import type { RecentTimeRange } from "@/hooks/use-recently-used-times"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"
import { formatTimestampInTimezone } from "@/lib/timezone-format"

interface RecentlyUsedProps {
	recentTimes: RecentTimeRange[]
	onSelect: (item: RecentTimeRange) => void
}

const MAX_VISIBLE = 4

/** Custom ranges are stored absolute, so they read as their bounds rather than "Custom range". */
function recentLabel(item: RecentTimeRange, timeZone: string): string {
	if (!item.value.startsWith("custom-")) return item.label
	const start = formatTimestampInTimezone(item.startTime, { timeZone, style: "range" })
	const end = formatTimestampInTimezone(item.endTime, { timeZone, style: "range" })
	return `${start} \u2013 ${end}`
}

export function RecentlyUsed({ recentTimes, onSelect }: RecentlyUsedProps) {
	const { effectiveTimezone } = useTimezonePreference()
	if (recentTimes.length === 0) {
		return null
	}

	const visible = recentTimes.slice(0, MAX_VISIBLE)

	return (
		<div className="space-y-2">
			<Eyebrow as="div">Recent</Eyebrow>
			<div className="flex flex-col">
				{visible.map((item) => (
					<button
						key={item.value}
						type="button"
						onClick={() => onSelect(item)}
						className="group flex h-7 items-center gap-2 rounded-sm px-2 text-left text-xs text-foreground/80 transition-colors hover:bg-muted/50 hover:text-foreground"
					>
						<HistoryIcon className="size-3 shrink-0 text-muted-foreground/60 group-hover:text-muted-foreground" />
						<span className="truncate" title={recentLabel(item, effectiveTimezone)}>
							{recentLabel(item, effectiveTimezone)}
						</span>
					</button>
				))}
			</div>
		</div>
	)
}
