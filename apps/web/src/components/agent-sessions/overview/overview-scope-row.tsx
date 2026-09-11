import { XmarkIcon } from "@/components/icons"
import { cn } from "@maple/ui/lib/utils"

import type { OverviewFilterChip } from "@/lib/agent-sessions/overview-search"

export interface OverviewScopeRowProps {
	chips: ReadonlyArray<OverviewFilterChip>
	/** What the filters matched, in one sentence. */
	summary: string
	onRemove: (chip: OverviewFilterChip) => void
	onClearAll: () => void
}

/**
 * Everything narrowing the board, stated once.
 *
 * The chips stay visible when the filters match nothing — a reader who has
 * narrowed to an empty set needs to see what they narrowed by, not an empty
 * page with no explanation.
 */
export function OverviewScopeRow({ chips, summary, onRemove, onClearAll }: OverviewScopeRowProps) {
	return (
		<div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-b border-border px-6 py-2.5">
			<span className="font-mono text-[10.5px] uppercase tracking-[0.09em] text-muted-foreground/70">
				Scope
			</span>
			{chips.length === 0 ? (
				<span className="font-mono text-[11.5px] text-muted-foreground/70">
					all sessions in range
				</span>
			) : (
				chips.map((chip) => (
					<button
						key={chip.dimension}
						type="button"
						aria-label={`Remove ${chip.dimension} filter`}
						onClick={() => onRemove(chip)}
						className={cn(
							"inline-flex h-[22px] items-center gap-1.5 rounded border border-primary/35 bg-primary/10 px-2",
							"font-mono text-[11.5px] text-primary transition-colors hover:bg-primary/15",
						)}
					>
						<span className="text-primary/70">{chip.dimension}</span>
						{chip.value}
						<XmarkIcon size={10} aria-hidden />
					</button>
				))
			)}
			{chips.length === 0 ? null : (
				<button
					type="button"
					onClick={onClearAll}
					className="font-mono text-[11.5px] text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
				>
					Clear all
				</button>
			)}
			<span className="ml-auto font-mono text-[11.5px] tabular-nums text-muted-foreground">
				{summary}
			</span>
		</div>
	)
}
