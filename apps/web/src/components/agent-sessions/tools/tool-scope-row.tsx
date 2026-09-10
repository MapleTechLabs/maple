import { cn } from "@maple/ui/lib/utils"

/** One removable piece of the current scope. */
export interface ToolScopeChip {
	readonly kind: "tool" | "model"
	readonly value: string
}

/**
 * What the page is currently about, and one click out of each of it.
 *
 * Both chips are drawn in the primary, the same colour as the metric tile's
 * rail and the picked table row — because they are the same thing seen from a
 * different angle. The reader set this scope by clicking a row that lit up
 * orange; the chip is where that lit-up state went. Distinguishing tool from
 * model by colour would have said the two selections are different in kind, and
 * they are not: they are two coordinates of one scope, and both come off the
 * same way.
 *
 * The count sentence sits on the same line rather than under the chart, because
 * "N of M calls match" is a statement about the chips beside it — remove one and
 * the number moves.
 */
export function ToolScopeRow({
	chips,
	summary,
	onRemove,
	onClearAll,
	className,
}: {
	chips: ReadonlyArray<ToolScopeChip>
	/** "120 of 4.0K calls match · 8 sessions" — see `scopeSummary`. */
	summary: string
	onRemove: (chip: ToolScopeChip) => void
	onClearAll: () => void
	className?: string
}) {
	return (
		<div className={cn("flex flex-wrap items-center gap-x-3 gap-y-2", className)}>
			{chips.length > 0 && (
				<div className="flex flex-wrap items-center gap-1.5">
					{chips.map((chip) => (
						<button
							key={`${chip.kind}:${chip.value}`}
							type="button"
							onClick={() => onRemove(chip)}
							title={`Remove ${chip.kind} ${chip.value}`}
							className="inline-flex max-w-64 items-center gap-1.5 rounded-sm border border-primary/40 bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary transition-colors hover:bg-primary/20"
						>
							<span className="text-primary/70">{chip.kind}</span>
							<span className="truncate">{chip.value}</span>
							<span aria-hidden>✕</span>
						</button>
					))}
					<button
						type="button"
						onClick={onClearAll}
						className="px-1 text-[10px] text-muted-foreground underline-offset-2 hover:underline"
					>
						Clear all
					</button>
				</div>
			)}
			<span className="font-mono text-[11px] tabular-nums text-muted-foreground">{summary}</span>
		</div>
	)
}
