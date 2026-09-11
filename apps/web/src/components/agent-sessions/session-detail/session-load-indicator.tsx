import type { GetAiSessionSummaryResponse } from "@maple/domain/http"
import { Button } from "@maple/ui/components/ui/button"
import { Spinner } from "@maple/ui/components/ui/spinner"
import { cn } from "@maple/ui/lib/utils"

import type { SessionLoadProgress } from "@/hooks/use-session-spans"

/**
 * The page's one sign that a session larger than a page is still arriving:
 * a count, a bar, and — only if a page failed — a way to resume. Quiet on
 * purpose. Every view already renders what is in hand and grows as pages
 * land, so this says how far along that is and nothing else.
 *
 * The count is of the phase in flight: the agent's spans first (the totals'
 * `aiSpanCount` is the denominator), then every span (`spanCount`). Without
 * the totals — they come from their own read, and may not have landed — the
 * count stands alone and the bar stays indeterminate.
 */
export function SessionLoadIndicator({
	progress,
	totals,
	className,
}: {
	progress: SessionLoadProgress
	totals: GetAiSessionSummaryResponse | undefined
	className?: string
}) {
	const { phase } = progress
	const format = (value: number) => value.toLocaleString("en-US")

	if (phase === "failed") {
		return (
			<div
				data-testid="session-load-indicator"
				className={cn("flex items-center gap-2 text-xs text-muted-foreground", className)}
			>
				<span>Couldn't load the rest of this session.</span>
				<Button variant="outline" size="xs" onClick={progress.retry}>
					Retry
				</Button>
			</div>
		)
	}

	const loaded = phase === "agent" ? progress.loadedAgentSpans : progress.loadedSpans
	const total = totals === undefined ? undefined : phase === "agent" ? totals.aiSpanCount : totals.spanCount
	// A total the loaded count has passed is a session still being written;
	// the bar fills rather than overflows.
	const fraction = total === undefined || total <= 0 ? undefined : Math.min(1, loaded / total)
	const noun = phase === "agent" ? "agent spans" : "spans"

	return (
		<div
			data-testid="session-load-indicator"
			aria-live="polite"
			className={cn("flex min-w-0 flex-col gap-1 text-xs text-muted-foreground", className)}
		>
			<div className="flex items-center gap-2">
				<Spinner size={12} className="shrink-0" aria-hidden />
				<span className="tabular-nums">
					Loading {format(loaded)}
					{total !== undefined && ` of ${format(total)}`} {noun}
				</span>
			</div>
			<div className="h-0.5 w-40 overflow-hidden rounded-full bg-muted" aria-hidden>
				<div
					className={cn(
						"h-full rounded-full bg-primary/70 transition-[width] duration-300",
						fraction === undefined && "w-1/3 animate-pulse",
					)}
					style={fraction === undefined ? undefined : { width: `${Math.round(fraction * 100)}%` }}
				/>
			</div>
		</div>
	)
}
