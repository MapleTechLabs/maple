import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { refreshingClass } from "@maple/ui/lib/refreshing"
import { FilterChip } from "@maple/ui/components/ui/filter-chip"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Tone } from "@maple/ui/lib/tone"

interface ReplaysToolbarProps {
	/** Current `q` search param (URL substring filter). */
	query: string
	onSearch: (value: string | undefined) => void
	/** Facet count behind the one-click error filter chip. */
	errorSessions: number
	/** `hasErrors` URL filter state — the chip toggles it. */
	errorsOnly: boolean
	onToggleErrorsOnly: () => void
	/** Facet count behind the "engaged" tier chip; hidden until known. */
	engagedSessions?: number
	/** Whether the `engaged` session tag is selected — the chip toggles it. */
	engagedOnly: boolean
	onToggleEngagedOnly: () => void
	/** Dim the chips while the list is refetching. */
	waiting?: boolean
}

/**
 * Search + one-click triage chips. The session/live totals live in the page
 * header; this row answers "what should I watch first" — errored sessions and
 * engaged sessions (everything but bots, bounces, idle tabs and glances) are each
 * one click away.
 */
export function ReplaysToolbar({
	query,
	onSearch,
	errorSessions,
	errorsOnly,
	onToggleErrorsOnly,
	engagedSessions,
	engagedOnly,
	onToggleEngagedOnly,
	waiting = false,
}: ReplaysToolbarProps) {
	return (
		// Bare container rather than the shared `Toolbar`: this sits inside
		// `PageLayout.StickyArea`, which already supplies the border and padding.
		<div className="flex flex-wrap items-center justify-between gap-3">
			<ToolbarSearch
				query={query}
				onSearch={onSearch}
				placeholder="Search by URL…"
				className="w-full sm:max-w-sm"
			/>

			<div
				aria-busy={waiting || undefined}
				className={cn("flex flex-wrap items-center gap-2", refreshingClass(waiting))}
			>
				<TriageChip
					pressed={errorsOnly}
					onToggle={onToggleErrorsOnly}
					tooltip={errorsOnly ? "Show all sessions" : "Show only sessions with errors"}
					tone="crit"
				>
					<span className="tabular-nums">{formatNumber(errorSessions)}</span> with errors
				</TriageChip>

				<TriageChip
					pressed={engagedOnly}
					onToggle={onToggleEngagedOnly}
					tooltip={
						engagedOnly ? "Show every session type" : "Hide bots, bounces, idle tabs and glances"
					}
					tone="ok"
				>
					{engagedSessions !== undefined && (
						<span className="tabular-nums">{formatNumber(engagedSessions)}</span>
					)}
					engaged
				</TriageChip>
			</div>
		</div>
	)
}

function TriageChip({
	pressed,
	onToggle,
	tooltip,
	tone,
	children,
}: {
	pressed: boolean
	onToggle: () => void
	tooltip: string
	tone: Tone
	children: React.ReactNode
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<FilterChip pressed={pressed} onPressedChange={() => onToggle()} tone={tone} dot>
						{children}
					</FilterChip>
				}
			/>
			<TooltipContent>{tooltip}</TooltipContent>
		</Tooltip>
	)
}
