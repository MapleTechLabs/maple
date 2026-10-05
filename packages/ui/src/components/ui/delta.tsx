import type * as React from "react"
import { formatPercent } from "../../lib/format"
import { cn } from "../../lib/utils"

/** Relative change from `previous` to `current`, or null when there is no baseline. */
export function relativeChange(current: number, previous: number): number | null {
	if (!Number.isFinite(previous) || previous <= 0 || !Number.isFinite(current)) return null
	return (current - previous) / previous
}

/**
 * Change against a previous window. Colour follows improvement, not direction
 * (`invert` for metrics where down is good, like error rate or latency); the
 * arrow always points the way the number moved, so colour is never the only cue.
 */
export function Delta({
	ratio,
	current,
	previous,
	invert = false,
	suffix,
	flatThreshold = 0.001,
	className,
}: {
	/** Relative change (0.12 = +12%). Or pass `current` + `previous`. */
	ratio?: number | null
	current?: number
	previous?: number
	invert?: boolean
	/** Trailing muted text, e.g. "vs prev". */
	suffix?: React.ReactNode
	/** |ratio| below this renders as flat. */
	flatThreshold?: number
	className?: string
}): React.ReactElement {
	const change =
		ratio !== undefined
			? ratio
			: current !== undefined && previous !== undefined
				? relativeChange(current, previous)
				: null

	if (change === null || !Number.isFinite(change)) {
		return <span className={cn("tabular-nums text-muted-foreground/60", className)}>–</span>
	}

	const flat = Math.abs(change) < flatThreshold
	const rose = change > 0
	const good = invert ? !rose : rose
	const magnitude = formatPercent(Math.abs(change))

	return (
		<span
			className={cn(
				"inline-flex items-center gap-1 tabular-nums",
				flat ? "text-muted-foreground/70" : good ? "text-severity-info" : "text-severity-error",
				className,
			)}
			title={`${flat ? "Flat" : rose ? "Up" : "Down"} ${magnitude} vs the previous period`}
			data-slot="delta"
		>
			<span aria-hidden>{flat ? "→" : rose ? "↑" : "↓"}</span>
			{magnitude}
			{suffix ? <span className="text-muted-foreground/50">{suffix}</span> : null}
		</span>
	)
}
