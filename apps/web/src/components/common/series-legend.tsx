import type { ReactNode } from "react"

import { cn } from "@maple/ui/lib/utils"

export interface SeriesLegendItem {
	key: string
	/** Omit (with `color`) for a single-series chart where the value alone reads. */
	label?: ReactNode
	color?: string
	value?: ReactNode
}

const VARIANTS = {
	inline: {
		root: "flex flex-wrap items-center justify-end gap-x-3 gap-y-1",
		item: "inline-flex items-baseline gap-1.5",
		dot: "size-1.5 translate-y-[-1px] rounded-full",
		label: "text-2xs text-muted-foreground",
		value: "font-mono text-2xs text-foreground/85 tabular-nums",
	},
	chip: {
		root: "flex flex-wrap items-center gap-2",
		item: "inline-flex items-center gap-1.5 rounded-full border bg-background px-2 py-0.5 text-2xs",
		dot: "size-2 rounded-full",
		label: "font-medium text-foreground/80",
		value: "font-mono text-muted-foreground tabular-nums",
	},
} as const

/** Per-series colour dot, label and last value beside a chart. Hook-free: charts call it mid-render. */
export function SeriesLegend({
	items,
	variant = "inline",
	className,
}: {
	items: ReadonlyArray<SeriesLegendItem>
	variant?: keyof typeof VARIANTS
	className?: string
}) {
	const styles = VARIANTS[variant]
	return (
		<div className={cn(styles.root, className)}>
			{items.map((item) => (
				<span key={item.key} className={styles.item}>
					{item.color !== undefined && (
						<span aria-hidden className={styles.dot} style={{ background: item.color }} />
					)}
					{item.label !== undefined && <span className={styles.label}>{item.label}</span>}
					{item.value !== undefined && <span className={styles.value}>{item.value}</span>}
				</span>
			))}
		</div>
	)
}
