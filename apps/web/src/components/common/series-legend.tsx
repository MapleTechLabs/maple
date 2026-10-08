import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

export interface SeriesLegendItem {
	key: string
	/** Omit (with `color`) for a single-series chart where the value alone reads. */
	label?: ReactNode
	/** The label's hover title, for a label truncated to fit. */
	title?: string
	color?: string
	value?: ReactNode
	/** Overrides the legend's `swatch` for this item (a dashed comparison line among solid ones). */
	swatch?: SeriesLegendSwatch
}

/** How a series is keyed: a dot or square for fills and bars, a stroke for lines. */
export type SeriesLegendSwatch = "dot" | "square" | "line" | "dashed"

const VARIANTS = {
	inline: {
		root: "flex flex-wrap items-center justify-end gap-x-3 gap-y-1",
		item: "inline-flex min-w-0 items-baseline gap-1.5",
		dot: "size-1.5 translate-y-[-1px]",
		label: "max-w-[24ch] truncate text-2xs text-muted-foreground",
		value: "font-mono text-2xs text-foreground/85 tabular-nums",
	},
	chip: {
		root: "flex flex-wrap items-center gap-2",
		item: "inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-2xs",
		dot: "size-2",
		label: "font-medium text-foreground/80",
		value: "font-mono text-muted-foreground tabular-nums",
	},
} as const

function Swatch({ kind, color, size }: { kind: SeriesLegendSwatch; color: string; size: string }) {
	switch (kind) {
		case "line":
			return (
				<span
					aria-hidden
					className="h-0.5 w-3 shrink-0 self-center rounded-full"
					style={{ background: color }}
				/>
			)
		case "dashed":
			return (
				<span
					aria-hidden
					className="w-3 shrink-0 self-center border-t border-dashed"
					style={{ borderColor: color }}
				/>
			)
		case "square":
			return (
				<span aria-hidden className={cn(size, "shrink-0 rounded-xs")} style={{ background: color }} />
			)
		case "dot":
			return (
				<span
					aria-hidden
					className={cn(size, "shrink-0 rounded-full")}
					style={{ background: color }}
				/>
			)
	}
}

/**
 * Per-series swatch, label and last value beside a chart. Hook-free: charts call
 * it mid-render. Past `maxItems` the rest collapse into a "+N" count.
 */
export function SeriesLegend({
	items,
	variant = "inline",
	swatch = "dot",
	maxItems,
	className,
}: {
	items: ReadonlyArray<SeriesLegendItem>
	variant?: keyof typeof VARIANTS
	swatch?: SeriesLegendSwatch
	maxItems?: number
	className?: string
}) {
	const styles = VARIANTS[variant]
	const shown = maxItems === undefined ? items : items.slice(0, maxItems)
	const overflow = items.length - shown.length
	return (
		<div className={cn(styles.root, className)}>
			{shown.map((item) => (
				<span key={item.key} className={styles.item}>
					{item.color !== undefined && (
						<Swatch kind={item.swatch ?? swatch} color={item.color} size={styles.dot} />
					)}
					{item.label !== undefined && (
						<span className={styles.label} title={item.title}>
							{item.label}
						</span>
					)}
					{item.value !== undefined && <span className={styles.value}>{item.value}</span>}
				</span>
			))}
			{overflow > 0 ? <span className="text-2xs text-muted-foreground/70">+{overflow}</span> : null}
		</div>
	)
}
