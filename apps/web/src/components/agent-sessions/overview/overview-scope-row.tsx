import { XmarkIcon } from "@/components/icons"

import { OVERVIEW_DIMENSIONS, type OverviewFilterChip } from "@/lib/agent-sessions/overview-search"

export interface OverviewScopeRowProps {
	chips: ReadonlyArray<OverviewFilterChip>
	/** What the filters matched, in one sentence. */
	summary: string
	onRemove: (chip: OverviewFilterChip) => void
	onClearAll: () => void
}

/**
 * Everything narrowing the board, stated once — and, after it, everything that
 * is not, so a reader can tell a scope of one dimension from a scope of five
 * without counting chips.
 *
 * The chips stay visible when the filters match nothing: a reader who has
 * narrowed to an empty set needs to see what they narrowed by, not an empty
 * page with no explanation.
 */
export function OverviewScopeRow({ chips, summary, onRemove, onClearAll }: OverviewScopeRowProps) {
	const narrowed = new Set(chips.map((chip) => chip.dimension))
	const open = OVERVIEW_DIMENSIONS.filter((dimension) => !narrowed.has(dimension))

	return (
		<div className="flex flex-wrap items-center gap-x-2 gap-y-2 border-b border-border bg-card px-6 py-2.5">
			<span className="font-mono text-[10.5px] leading-[14px] tracking-[0.06em] text-muted-foreground/60 uppercase">
				Scope
			</span>

			{chips.map((chip) => (
				<button
					key={chip.dimension}
					type="button"
					aria-label={`Remove ${chip.dimension} filter`}
					onClick={() => onRemove(chip)}
					className="inline-flex h-[22px] max-w-full items-center gap-[5px] rounded-sm border border-primary/35 bg-primary/10 px-2 font-mono text-[11.5px] leading-[14px] text-primary transition-colors hover:bg-primary/15"
				>
					<span className="shrink-0 text-[10.5px] text-primary/70">{chip.dimension}</span>
					<span className="min-w-0 truncate">{chip.value}</span>
					<XmarkIcon size={10} className="shrink-0 text-primary/70" aria-hidden />
				</button>
			))}

			{chips.length === 0 ? null : (
				<button
					type="button"
					onClick={onClearAll}
					className="font-mono text-[10.5px] leading-[14px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Clear all
				</button>
			)}

			{open.length === 0 ? null : (
				<span className="min-w-0 truncate font-mono text-[10.5px] leading-[14px] text-muted-foreground/60">
					{chips.length === 0 ? "" : "· "}
					{open.map((dimension) => `all ${dimension}s`).join(" · ")}
				</span>
			)}

			<span className="ml-auto shrink-0 font-mono text-[11.5px] tabular-nums text-muted-foreground">
				{summary}
			</span>
		</div>
	)
}
