import { ToolbarSearch } from "@maple/ui/components/toolbar"
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
				<button
					type="button"
					onClick={onToggleErrorsOnly}
					aria-pressed={errorsOnly}
					title={errorsOnly ? "Show all sessions" : "Show only sessions with errors"}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
						errorsOnly
							? "border-destructive bg-destructive text-white"
							: "border-destructive/30 bg-destructive/10 text-destructive hover:bg-destructive/15",
					)}
				>
					<span
						className={cn("size-1.5 rounded-full", errorsOnly ? "bg-white" : "bg-destructive")}
						aria-hidden
					/>
					<span className="tabular-nums">{errorSessions.toLocaleString()}</span> with errors
				</button>

				<button
					type="button"
					onClick={onToggleEngagedOnly}
					aria-pressed={engagedOnly}
					title={
						engagedOnly ? "Show every session type" : "Hide bots, bounces, idle tabs and glances"
					}
					className={cn(
						"inline-flex h-7 items-center gap-1.5 rounded-full border px-3 text-xs font-medium transition-colors",
						engagedOnly
							? "border-emerald-600 bg-emerald-600 text-white"
							: "border-emerald-500/30 bg-emerald-500/10 text-emerald-600 hover:bg-emerald-500/15 dark:text-emerald-400",
					)}
				>
					<span
						className={cn("size-1.5 rounded-full", engagedOnly ? "bg-white" : "bg-emerald-500")}
						aria-hidden
					/>
					{engagedSessions !== undefined && (
						<span className="tabular-nums">{engagedSessions.toLocaleString()}</span>
					)}
					engaged
				</button>
			</div>
		</div>
	)
}
