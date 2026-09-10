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
	// The leading number is the answer; the rest of the sentence is its unit.
	const [count, ...rest] = summary.split(" ")

	return (
		<div
			className={cn(
				"flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-border bg-card px-6 py-2.5 font-mono",
				className,
			)}
		>
			<div className="flex flex-wrap items-center gap-2">
				<span className="text-[10.5px] tracking-[0.06em] text-muted-foreground/60">SCOPE</span>
				{chips.length === 0 ? (
					<span className="text-[11px] text-muted-foreground/60">all tools · all models</span>
				) : (
					<>
						{chips.map((chip) => (
							<button
								key={`${chip.kind}:${chip.value}`}
								type="button"
								onClick={() => onRemove(chip)}
								title={`Remove ${chip.kind} ${chip.value}`}
								className="inline-flex h-[22px] max-w-64 items-center gap-[5px] rounded-sm border border-primary/35 bg-primary/10 px-2 transition-colors hover:bg-primary/20"
							>
								<span className="text-[10.5px] text-muted-foreground">{chip.kind}</span>
								<span className="truncate text-[11.5px] text-primary">{chip.value}</span>
								<span aria-hidden className="text-[11px] text-muted-foreground">
									✕
								</span>
							</button>
						))}
						<button
							type="button"
							onClick={onClearAll}
							className="pl-0.5 text-[10.5px] text-muted-foreground underline-offset-2 hover:underline"
						>
							Clear all
						</button>
					</>
				)}
			</div>
			<span className="flex items-center gap-1.5 text-[11.5px] tabular-nums">
				<span className="text-foreground">{count}</span>
				<span className="text-muted-foreground">{rest.join(" ")}</span>
			</span>
		</div>
	)
}
