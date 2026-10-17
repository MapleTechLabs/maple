// Says when the views show older results than the ones asked for, and why: the
// server is busy (chDB answers one query at a time), unreachable, or a refresh
// failed. Floats over the content so a load that finishes fast never shifts it.

import { useQueryClient } from "@tanstack/react-query"
import { Button } from "@maple/ui/components/ui/button"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { TONE_BORDER, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { useShownData } from "../hooks/use-shown-data"
import { useLocalServerStatus } from "../hooks/use-local-server-status"

const timeOnly = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" })
const dayAndTime = new Intl.DateTimeFormat(undefined, {
	month: "short",
	day: "numeric",
	hour: "2-digit",
	minute: "2-digit",
})

/** "20:14" today, "Oct 14, 20:14" before that. */
export function formatAsOf(ms: number, nowMs = Date.now()): string {
	const sameDay = new Date(ms).toDateString() === new Date(nowMs).toDateString()
	return (sameDay ? timeOnly : dayAndTime).format(ms)
}

interface Notice {
	readonly tone: Tone
	readonly text: string
	readonly retry: boolean
}

export function describeNotice(input: {
	readonly disconnected: boolean
	readonly busy: boolean
	readonly refreshFailed: boolean
	readonly shownAsOfMs: number | null
	readonly staleAsOfMs: number | null
	readonly nowMs?: number
}): Notice | null {
	const asOf = (ms: number | null) =>
		ms === null ? "" : ` Showing results from ${formatAsOf(ms, input.nowMs)}.`
	if (input.disconnected)
		return { tone: "crit", text: `Can’t reach Maple Local.${asOf(input.shownAsOfMs)}`, retry: true }
	if (input.staleAsOfMs === null) return null
	if (input.refreshFailed)
		return { tone: "warn", text: `Couldn’t refresh.${asOf(input.staleAsOfMs)}`, retry: true }
	if (input.busy)
		return { tone: "warn", text: `Maple Local is busy.${asOf(input.staleAsOfMs)}`, retry: false }
	return { tone: "neutral", text: `Loading newer results.${asOf(input.staleAsOfMs)}`, retry: false }
}

export function StaleDataNotice({ disconnected, onRetry }: { disconnected: boolean; onRetry: () => void }) {
	const client = useQueryClient()
	const shown = useShownData()
	const { data: status } = useLocalServerStatus()
	const notice = describeNotice({
		disconnected,
		busy: status?.reachability === "busy",
		refreshFailed: shown.refreshFailed,
		shownAsOfMs: shown.shownAsOfMs,
		staleAsOfMs: shown.staleAsOfMs,
	})
	if (notice === null) return null
	const retry = () => {
		onRetry()
		void client.refetchQueries({ queryKey: ["local"], type: "active" })
	}
	return (
		<div className="pointer-events-none absolute inset-x-0 bottom-4 z-20 flex justify-center px-4">
			<output
				className={cn(
					"stale-notice pointer-events-auto flex max-w-full items-center gap-2 rounded-full border bg-popover py-1 pr-1 pl-3 text-xs text-popover-foreground shadow-sm",
					TONE_BORDER[notice.tone],
					!notice.retry && "pr-3",
				)}
			>
				<StatusDot tone={notice.tone} />
				<span className="truncate">{notice.text}</span>
				{notice.retry ? (
					<Button variant="ghost" size="xs" className="rounded-full" onClick={retry}>
						Try again
					</Button>
				) : null}
			</output>
		</div>
	)
}
