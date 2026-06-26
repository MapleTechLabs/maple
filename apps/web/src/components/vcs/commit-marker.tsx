import { type ReactNode, useRef } from "react"

import { Result, useAtomValue } from "@/lib/effect-atom"
import type { ChartReferenceLine } from "@maple/ui/components/charts/_shared/chart-types"
import { cn } from "@maple/ui/utils"

import { CommitShaHoverCard, commitQueryAtom, isResolvableSha } from "./commit-sha-hover-card"

// Deploy markers open on a much longer dwell than an inline SHA. Their hitbox runs
// the entire reference line, so a short delay would pop the card open whenever the
// cursor merely crossed the chart — ~1.5s requires an intentional hover.
const MARKER_OPEN_DELAY_MS = 800

// The line hitbox: a narrow, transparent, full-height strip centered on the
// reference line. Hovering anywhere along it (or the flag at its top) opens the
// card. Kept narrow so it barely intrudes on the chart's own hover tooltip. `group`
// lets the flag highlight while the cursor is anywhere on the line.
const HITBOX_CLASS = "group pointer-events-auto relative block h-full w-4 cursor-pointer"

/**
 * The interactive flag plus full-line hover hitbox for a release/deploy marker on
 * a service chart. The flag sits at the top of the line; hovering anywhere on the
 * line resolves and previews the commit via {@link CommitShaHoverCard}. The card
 * anchors to the flag (not the full-height hitbox) so it opens beside the flag
 * rather than at the chart's bottom edge.
 */
export function CommitDeployMarker({ line }: { line: ChartReferenceLine }) {
	const sha = line.sha ?? ""
	const flagRef = useRef<HTMLDivElement>(null)
	const fallback = line.label ?? sha.slice(0, 7)

	return (
		<CommitShaHoverCard
			sha={sha}
			openDelay={MARKER_OPEN_DELAY_MS}
			anchor={flagRef}
			side="bottom"
			align="start"
			className={HITBOX_CLASS}
		>
			<div
				ref={flagRef}
				className="absolute left-1/2 top-0 -translate-x-1/2 rounded-full border border-border/60 bg-card/95 px-1.5 py-0.5 text-muted-foreground shadow-sm backdrop-blur transition-colors group-hover:text-foreground"
			>
				<MarkerFlagLabel sha={sha} fallback={fallback} />
			</div>
		</CommitShaHoverCard>
	)
}

// The flag's text: the commit's subject line once resolved, otherwise the short
// SHA. Non-resolvable refs (short SHA / tag / arbitrary telemetry) never fetch.
function MarkerFlagLabel({ sha, fallback }: { sha: string; fallback: string }) {
	if (!isResolvableSha(sha)) {
		return <FlagText title={fallback}>{fallback}</FlagText>
	}
	return <ResolvedFlagLabel sha={sha} fallback={fallback} />
}

// Subscribes to the same per-SHA atom the hover card uses, so resolving the flag's
// message also primes the card (its open is then an instant cache hit). Falls back
// to the short SHA while loading or when the commit can't be resolved.
function ResolvedFlagLabel({ sha, fallback }: { sha: string; fallback: string }) {
	const result = useAtomValue(commitQueryAtom(sha))
	const message = Result.builder(result)
		.onSuccess((commit) => firstLine(commit.message))
		.orElse(() => null)

	if (message) {
		return (
			<FlagText title={message} className="max-w-[150px]">
				{message}
			</FlagText>
		)
	}
	return <FlagText title={fallback}>{fallback}</FlagText>
}

function FlagText({
	children,
	title,
	className,
}: {
	children: ReactNode
	title: string
	className?: string
}) {
	return (
		<span
			title={title}
			className={cn("block truncate font-mono text-[10px] leading-none", className)}
		>
			{children}
		</span>
	)
}

function firstLine(message: string): string {
	const idx = message.indexOf("\n")
	return (idx === -1 ? message : message.slice(0, idx)).trim()
}
