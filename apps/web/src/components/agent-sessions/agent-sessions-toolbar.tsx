import type { ReactNode } from "react"
import { ToolbarSearch, ToolbarStat } from "@maple/ui/components/toolbar"
import { Switch } from "@maple/ui/components/ui/switch"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

interface AgentSessionsToolbarProps {
	/** Current `q` search param (session / trace id prefix). */
	query: string
	onSearch: (value: string | undefined) => void
	/** `hasErrors` URL filter state — the switch toggles it. */
	errorsOnly: boolean
	onToggleErrorsOnly: () => void
	/** Sessions loaded so far, for the count beside the controls; `undefined`
	 *  until the first page lands. */
	sessionCount: number | undefined
	/** Dim the controls while the list is refetching. */
	waiting?: boolean
	/** Trailing controls — the route's Reload button. */
	actions?: ReactNode
}

/**
 * Search, the loaded count and the one-click error triage switch. The order
 * is the table's to set: its column headers sort it.
 */
export function AgentSessionsToolbar({
	query,
	onSearch,
	errorsOnly,
	onToggleErrorsOnly,
	sessionCount,
	waiting = false,
	actions,
}: AgentSessionsToolbarProps) {
	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `DashboardLayout.Sticky`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Session or trace ID…"
				className="w-full sm:max-w-sm"
			/>

			<div
				className={cn(
					"flex flex-wrap items-center gap-4 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				{sessionCount !== undefined && (
					<Tooltip>
						<TooltipTrigger render={<span />} className="hidden sm:block">
							<ToolbarStat value={sessionCount} label="sessions" />
						</TooltipTrigger>
						<TooltipContent>Loaded so far — more load as you scroll</TooltipContent>
					</Tooltip>
				)}

				{/* A switch, not a chip: it is a filter that is on or off, and a
				    chip in the destructive tone read as a warning about the list. */}
				<Tooltip>
					<TooltipTrigger
						render={<label />}
						className="inline-flex cursor-pointer items-center gap-2 text-xs font-medium"
					>
						<Switch
							checked={errorsOnly}
							onCheckedChange={onToggleErrorsOnly}
							className="[--thumb-size:--spacing(3.5)] data-checked:bg-destructive sm:[--thumb-size:--spacing(3.5)]"
						/>
						With errors
					</TooltipTrigger>
					<TooltipContent>Only sessions with a failed turn, tool call or span</TooltipContent>
				</Tooltip>

				{actions}
			</div>
		</div>
	)
}
