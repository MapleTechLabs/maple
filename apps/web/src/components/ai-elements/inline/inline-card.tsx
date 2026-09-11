import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"
import { ChevronRightIcon } from "@/components/icons"

/**
 * The shell every inline reference card shares.
 *
 * It deliberately borrows the tool card's language — `rounded-lg`, a full-strength
 * `border-border` over `bg-muted`, `px-3` gutters — because both sit in the same
 * assistant turn a few pixels apart, and two near-identical cards drawn with
 * different borders read as a rendering bug rather than two kinds of thing.
 *
 * The fill carries the card, not the border: on the dark theme `--muted` is only
 * 0.05 lightness above `--background`, so the first pass at 20% opacity over a
 * hairline at 60% put the whole card within a couple of percent of the page and it
 * read as a faint stripe rather than a thing you could click.
 *
 * No vertical margin: the parent (`RichText`, and `PART_STACK` above it) owns the
 * rhythm. Cards that set their own `my-*` inside a bubble stack margins against the
 * list gap and against each other.
 */
const SHELL =
	"@container/inline flex w-full flex-col gap-1 rounded-lg border border-border bg-muted px-3 py-2"

const LINK_SHELL =
	"transition-colors hover:border-ring/40 hover:bg-muted focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring/50"

export function inlineCardClass(interactive = false): string {
	return cn(SHELL, interactive && LINK_SHELL)
}

/** The card's headline: one line, everything on it shrink-proof except the name. */
export const INLINE_CARD_ROW = "flex min-w-0 items-center gap-2.5"

/**
 * The card's second line, for context that would otherwise crowd the headline off
 * the card — which is what the affected-service chips did to the very error message
 * they were describing. Indented to the headline's text, so the two lines read as
 * one block.
 */
export const INLINE_CARD_META = "flex min-w-0 flex-wrap items-center gap-1 ps-6"

/** The muted chevron that marks a card as a link, matching the tool row's affordance. */
export function InlineCardChevron() {
	return (
		<ChevronRightIcon className="size-3.5 shrink-0 text-muted-foreground/50 transition-colors group-hover/inline:text-muted-foreground" />
	)
}

/**
 * One right-hand metric.
 *
 * A right-aligned minimum width, not a fixed one: stacked cards are the common case
 * (the model lists three services, then four traces) and ragged metrics turn a list
 * into a jumble, but a value wider than its lane has to push rather than wrap — a
 * two-line `18.4K events` in a one-line card is worse than a lane that gives.
 */
export function InlineMetric({
	width,
	tone,
	children,
	unit,
	className,
}: {
	width: string
	tone?: string
	unit?: string
	children: ReactNode
	/** Container-query visibility, for the metrics a narrow card drops first. */
	className?: string
}) {
	return (
		<span
			className={cn(
				"shrink-0 whitespace-nowrap text-right font-mono text-xs tabular-nums",
				width,
				tone,
				className,
			)}
		>
			{children}
			{unit ? <span className="ms-1 font-sans text-muted-foreground">{unit}</span> : null}
		</span>
	)
}

/**
 * The services touched by a trace or an error — a hint at blast radius, not a legend.
 * Four, then a count: they live on the card's own line, so they can be read in full
 * rather than truncated to `web-paywall…`.
 */
export function InlineServiceChips({ services }: { services: readonly string[] }) {
	if (services.length === 0) return null
	const shown = services.slice(0, 4)
	return (
		<>
			{shown.map((service) => (
				<span
					key={service}
					className="min-w-0 truncate rounded-sm border border-border/70 bg-background/60 px-1.5 py-0.5 text-[11px] text-muted-foreground"
					title={service}
				>
					{service}
				</span>
			))}
			{services.length > shown.length ? (
				<span className="shrink-0 text-[11px] text-muted-foreground/70">
					+{services.length - shown.length}
				</span>
			) : null}
		</>
	)
}
