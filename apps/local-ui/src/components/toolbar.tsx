// Local bindings for the shared @maple/ui toolbar family: refresh moves the
// view's time window (or refetches when it is already current), and the range
// select is bound to local mode's presets.

import { useCallback } from "react"
import { useQueryClient } from "@tanstack/react-query"
import {
	RefreshButton as SharedRefreshButton,
	TimeRangeSelect as SharedTimeRangeSelect,
} from "@maple/ui/components/toolbar"
import { cn } from "@maple/ui/lib/utils"
import { useNewDataSince } from "../hooks/use-local-server-status"
import { TIME_RANGES } from "../lib/time"

export { Toolbar, ToolbarSearch, ToolbarStat, ToolbarStats } from "@maple/ui/components/toolbar"

/**
 * Manual reload for the active view. With a time window, refresh re-anchors it
 * to now (new query keys, so each query runs once); when the anchor is already
 * current it refetches the mounted `["local", ...]` queries instead. `since`
 * (the main query's `dataUpdatedAt`) turns on a "new data" hint once the
 * server has accepted telemetry after that.
 */
export function RefreshButton({
	className,
	advance,
	since = 0,
}: {
	className?: string
	advance?: () => boolean
	since?: number
}) {
	const queryClient = useQueryClient()
	const hasNewData = useNewDataSince(since)
	const onRefresh = useCallback((): Promise<unknown> => {
		if (advance?.()) return Promise.resolve()
		return queryClient.invalidateQueries({ queryKey: ["local"], refetchType: "active" })
	}, [advance, queryClient])

	return (
		<span className={cn("flex items-center gap-1", className)}>
			{hasNewData ? (
				<button
					type="button"
					onClick={() => void onRefresh()}
					className="inline-flex items-center gap-1.5 rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 text-xs font-medium whitespace-nowrap text-primary transition-colors hover:bg-primary/15"
				>
					<span className="size-1.5 rounded-full bg-primary" />
					New data
				</button>
			) : null}
			<SharedRefreshButton onRefresh={onRefresh} />
		</span>
	)
}

const RANGE_LABELS: Record<string, string> = {
	"1h": "Last 1 hour",
	"6h": "Last 6 hours",
	"24h": "Last 24 hours",
	"7d": "Last 7 days",
	"30d": "Last 30 days",
} satisfies Record<string, string>

const RANGE_OPTIONS = TIME_RANGES.map((range) => ({
	key: range.key,
	label: RANGE_LABELS[range.key] ?? range.label,
}))

export function TimeRangeSelect({ value, onChange }: { value: string; onChange: (next: string) => void }) {
	return <SharedTimeRangeSelect ranges={RANGE_OPTIONS} value={value} onChange={onChange} />
}
