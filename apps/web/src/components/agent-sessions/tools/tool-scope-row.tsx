import { Eyebrow } from "@maple/ui/components/ui/eyebrow"
import { Button } from "@maple/ui/components/ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"
import { cn } from "@maple/ui/lib/utils"

import { XmarkIcon } from "@/components/icons"

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
				<Eyebrow variant="mono">Scope</Eyebrow>
				{chips.length === 0 ? (
					<span className="text-2xs text-muted-foreground/60">all tools · all models</span>
				) : (
					<>
						{chips.map((chip) => (
							<Tooltip key={`${chip.kind}:${chip.value}`}>
								<TooltipTrigger
									render={<button type="button" />}
									aria-label={`Remove ${chip.kind} ${chip.value}`}
									onClick={() => onRemove(chip)}
									className="inline-flex h-[22px] max-w-64 items-center gap-[5px] rounded-sm border border-primary/35 bg-primary/10 px-2 transition-colors hover:bg-primary/20"
								>
									<span className="text-2xs text-muted-foreground">{chip.kind}</span>
									<span className="truncate text-2xs text-primary">{chip.value}</span>
									<XmarkIcon
										size={10}
										aria-hidden
										className="shrink-0 text-muted-foreground"
									/>
								</TooltipTrigger>
								<TooltipContent>{`Remove ${chip.kind} ${chip.value}`}</TooltipContent>
							</Tooltip>
						))}
						<Button
							variant="link"
							size="xs"
							onClick={onClearAll}
							className="h-auto px-0.5 text-2xs text-muted-foreground sm:text-2xs"
						>
							Clear all
						</Button>
					</>
				)}
			</div>
			<span className="flex items-center gap-1.5 text-2xs tabular-nums">
				<span className="text-foreground">{count}</span>
				<span className="text-muted-foreground">{rest.join(" ")}</span>
			</span>
		</div>
	)
}
