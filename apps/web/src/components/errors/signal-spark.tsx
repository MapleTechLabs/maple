import type { IssueSeverity } from "@maple/domain/http"
import { MiniBars } from "@maple/ui/components/ui/mini-bars"
import { cn } from "@maple/ui/lib/utils"

import { SEVERITY_TEXT } from "./severity-badge"

/**
 * The trend shape drawn inside a list row.
 *
 * Deliberately not `IssueOccurrenceChart`: that one is an axed, interactive
 * plot with a tooltip, built for the detail page. Fifty of them in a scrolling
 * list would be fifty chart runtimes. This is a static bar chart in one <svg>,
 * no runtime, no interaction — the same bars, drawn the cheap way.
 *
 * Colour carries the row's severity rather than decorating it, so a column of
 * sparks reads as a heat map of the queue — the red shapes are the ones worth
 * looking at, and you can find them without reading a single label.
 */

export interface SignalSparkProps {
	/** Dense bucket counts, oldest first. Gaps must already be zero-filled. */
	values: ReadonlyArray<number>
	severity: IssueSeverity | null
	/** Overrides the severity hue — a surging fingerprint reads as urgent
	 *  regardless of the severity someone assigned it. */
	surging?: boolean
	/** Bars past this point are drawn at full strength — the window's recent tail. */
	tailFraction?: number
	className?: string
	label?: string
}

/** One-pixel gaps between two-pixel bars, as a percent of the strip's width. */
const gapPercent = (count: number): number => 100 / (count * 3 - 1)

/**
 * A bucket that saw nothing still draws a 1/20 tick, so the comb has a floor and
 * the bars stand ON something; a bucket that saw errors clears 2.5/20, because
 * the difference between "one error" and "none" is the whole point of the shape.
 * A window that saw nothing at all stays blank: a floor under no data would claim some.
 */
export function SignalSpark({
	values,
	severity,
	surging = false,
	tailFraction = 0.2,
	className,
	label,
}: SignalSparkProps) {
	if (values.length === 0) {
		return (
			<span
				className={cn("block h-5 w-full", className)}
				aria-hidden="true"
				title="No occurrences in this window"
			/>
		)
	}

	const tone = surging
		? "text-severity-error"
		: severity === null
			? "text-muted-foreground"
			: SEVERITY_TEXT[severity]

	return (
		<MiniBars
			values={values}
			floor={Math.max(...values) > 0 ? 5 : 0}
			minHeight={12.5}
			gap={gapPercent(values.length)}
			tail={tailFraction}
			className={cn("h-5 w-full overflow-visible", tone, className)}
			label={label ?? "Occurrences over the selected window"}
		/>
	)
}
