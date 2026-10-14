import { Tooltip, TooltipContent, TooltipTrigger } from "@maple/ui/components/ui/tooltip"

/** avg → peak. One number can't distinguish a steady 60% from a spike to 100%. */
export function AvgPeak({
	avg,
	peak,
	format,
	note,
}: {
	avg: number
	peak: number
	format: (n: number) => string
	/** Extra line for the tooltip, e.g. how the source aggregates replicas. */
	note?: string
}) {
	return (
		<Tooltip>
			<TooltipTrigger
				render={
					<span className="cursor-default font-mono text-2xs tabular-nums text-foreground">
						<span className="text-muted-foreground">{format(avg)}</span>
						<span className="mx-1 text-foreground/30">→</span>
						{format(peak)}
					</span>
				}
			/>
			<TooltipContent>
				<div className="flex flex-col gap-1.5 py-0.5">
					<div className="grid grid-cols-[auto_auto] gap-x-4 gap-y-0.5 font-mono tabular-nums">
						<span className="text-muted-foreground">Average</span>
						<span className="text-right">{format(avg)}</span>
						<span className="text-muted-foreground">Peak</span>
						<span className="text-right">{format(peak)}</span>
					</div>
					<div className="text-muted-foreground">
						<div>Over the selected time range.</div>
						{note && <div>{note}</div>}
					</div>
				</div>
			</TooltipContent>
		</Tooltip>
	)
}
