import { Meter } from "@maple/ui/components/ui/meter"
import { cn } from "@maple/ui/lib/utils"
import { EMPTY_VALUE, formatPercent } from "@maple/ui/lib/format"

import { severityLevel } from "../format"
import { BAR_FILL, BAR_VALUE_TONE } from "../severity-tokens"

/**
 * The labelled utilization meter every infra table shows.
 *
 * This replaces four implementations of one idea: `MiniBar` (written twice,
 * verbatim, in the pod and container tables), `InlineMetricBars` (hosts, three
 * fixed rows), and `UsageBar` (workloads, which re-declared the severity colour
 * maps that `severity-tokens` already owns). They disagreed on bar height
 * (4/6/1px), radius, label width, value width, and label case — so no two infra
 * tables lined up, which is most of why the section read as assembled rather
 * than designed.
 *
 * Fixed lanes, not `gap` alone: the label and value columns are the same width
 * in every table, so meters align down the page and across sibling tables even
 * when one has two rows and another has three.
 */

/** Label lane. Wide enough for "MEM"; every table therefore starts its bar at the same x. */
const LABEL_WIDTH = "w-8"
/** Value lane. Wide enough for "100%". */
const VALUE_WIDTH = "w-9"

export interface Meter {
	/** Short, upper-case: CPU, MEM, DSK. */
	label: string
	/** 0–1. Values outside are clamped; non-finite renders as an em dash. */
	fraction: number
}

export function MeterRows({
	meters,
	/**
	 * Drop the label lane. For a table that gives each metric its own COLUMN
	 * (workloads sort CPU and memory independently, so they can't share a cell),
	 * the column head already names it and an inline label would say it twice.
	 * The value lane keeps its width either way, so sibling columns still align.
	 */
	hideLabels = false,
	className,
}: {
	meters: ReadonlyArray<Meter>
	hideLabels?: boolean
	className?: string
}) {
	return (
		<div className={cn("flex flex-col gap-1", className)}>
			{meters.map((meter) => (
				<MeterRow key={meter.label} {...meter} hideLabel={hideLabels} />
			))}
		</div>
	)
}

function MeterRow({ label, fraction, hideLabel }: Meter & { hideLabel?: boolean }) {
	const finite = Number.isFinite(fraction)
	const clamped = finite ? Math.max(0, Math.min(1, fraction)) : 0
	const level = severityLevel(clamped)

	return (
		<div className="flex items-center gap-2 leading-none">
			{!hideLabel && (
				<span
					className={cn(
						LABEL_WIDTH,
						"shrink-0 font-mono text-3xs tracking-[0.06em] text-muted-foreground/70",
					)}
				>
					{label}
				</span>
			)}
			<Meter value={clamped} className="h-[3px] flex-1 rounded-[1px]" fillClassName={BAR_FILL[level]} />
			<span
				className={cn(
					VALUE_WIDTH,
					"shrink-0 text-right font-mono text-2xs tabular-nums",
					BAR_VALUE_TONE[level],
				)}
			>
				{finite ? formatPercent(fraction) : EMPTY_VALUE}
			</span>
		</div>
	)
}
