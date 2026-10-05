import { ToolbarSearch } from "@maple/ui/components/toolbar"
import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { cn } from "@maple/ui/lib/utils"

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
				className={cn(
					"flex flex-wrap items-center gap-2 transition-opacity",
					waiting && "opacity-60",
				)}
			>
				<TriageChip
					pressed={errorsOnly}
					onToggle={onToggleErrorsOnly}
					title={errorsOnly ? "Show all sessions" : "Show only sessions with errors"}
					pressedClassName="border-destructive bg-destructive text-white"
					idleClassName="border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15"
					dotClassName="bg-destructive"
				>
					<span className="tabular-nums">{errorSessions.toLocaleString()}</span> with errors
				</TriageChip>

				<TriageChip
					pressed={engagedOnly}
					onToggle={onToggleEngagedOnly}
					title={
						engagedOnly ? "Show every session type" : "Hide bots, bounces, idle tabs and glances"
					}
					pressedClassName="border-emerald-600 bg-emerald-600 text-white"
					idleClassName="border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400"
					dotClassName="bg-emerald-500"
				>
					{engagedSessions !== undefined && (
						<span className="tabular-nums">{engagedSessions.toLocaleString()}</span>
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
	title,
	pressedClassName,
	idleClassName,
	dotClassName,
	children,
}: {
	pressed: boolean
	onToggle: () => void
	title: string
	pressedClassName: string
	idleClassName: string
	dotClassName: string
	children: React.ReactNode
}) {
	return (
		<button
			type="button"
			onClick={onToggle}
			aria-pressed={pressed}
			title={title}
			className={cn(
				"inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
				pressed ? pressedClassName : idleClassName,
			)}
		>
			<StatusDot tone="custom" className={pressed ? "bg-white" : dotClassName} />
			{children}
		</button>
	)
}
