import { StatusDot } from "@maple/ui/components/ui/status-dot"
import { ToggleGroupItem } from "@maple/ui/components/ui/toggle-group"
import type { Tone } from "@maple/ui/lib/tone"

/** One filter chip of a board's header: state color dot (or none for "All") + label + count. */
export function CountChip({
	value,
	label,
	count,
	tone,
}: {
	value: string
	label: string
	count: number
	tone?: Tone
}) {
	return (
		<ToggleGroupItem
			value={value}
			className="group h-6 gap-1.5 rounded-full border-border/60 px-2.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/60 hover:text-foreground data-pressed:border-transparent data-pressed:bg-muted data-pressed:text-foreground sm:h-6 sm:text-xs"
		>
			{tone ? <StatusDot tone={tone} /> : null}
			{label}
			<span className="tabular-nums text-muted-foreground/70 group-data-pressed:text-muted-foreground">
				{count}
			</span>
		</ToggleGroupItem>
	)
}
