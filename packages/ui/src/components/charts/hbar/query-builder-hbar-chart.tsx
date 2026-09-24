import * as React from "react"

import type { QueryBuilderHbarChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { pickValueField, toBreakdownRows, type BreakdownRow } from "../_shared/breakdown-rows"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { useContainerSize } from "../../../hooks/use-container-size"

// Ranked horizontal bars — the "top N by volume" panel.
//
// The funnel used to be the only row-per-category chart, so every ranking was
// built as one. That reads wrong twice over: a funnel implies sequential stages
// with a monotonic drop-off, and it labels each bar as a share of the LARGEST
// bar, so four unrelated operations of equal size all render "100%". Here rows
// are sorted by value and each percentage is a share of the **total**, which is
// the only reading that sums to 100% across the panel.

interface Bar extends BreakdownRow {
	color: string
	/** Bar length as a fraction of the largest row (0–1). */
	widthPct: number
	/** Share of the total across all rows (0–1). */
	pctOfTotal: number
}

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

function fmtPct(fraction: number): string {
	const pct = fraction * 100
	if (pct > 0 && pct < 0.1) return "<0.1%"
	return `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%`
}

const ROW_GAP = 6
const ROW_MIN_H = 18
const ROW_FULL_H = ROW_MIN_H + ROW_GAP
/**
 * A short list stretches to fill the card rather than floating in it: rows
 * grow up to this, and the bar thickens with them, so five operations in a
 * tall panel read as five generous rows instead of a strip in a void.
 */
const ROW_MAX_H = 56
const BAR_MIN_THICKNESS = 10
const BAR_MAX_THICKNESS = 20
/** A row with a real but tiny value still has to be visible. */
const BAR_MIN_PCT = 0.02
const MORE_ROW_H = 16

// No sample-data fallback: substituting fixtures for real rows made every
// misconfigured or mis-fed chart draw a plausible-looking picture instead of an
// empty one. Gallery thumbnails pass their sample rows in explicitly via `data`.
const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

export function QueryBuilderHbarChart({ data, className, unit }: QueryBuilderHbarChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { height } = useContainerSize(containerRef)

	const bars = React.useMemo(() => {
		// Sorted here rather than trusted from the query: the panel's whole claim
		// is that it is ranked, and a breakdown without an ORDER BY isn't.
		const rows = toBreakdownRows(source, valueField)
			.filter((row) => row.value > 0)
			.sort((a, b) => b.value - a.value)
		const max = rows[0]?.value ?? 0
		const total = rows.reduce((acc, row) => acc + row.value, 0)
		if (max <= 0) return [] as Bar[]
		const colors = resolveSeriesColors(rows.map((row) => row.name))
		return rows.map(
			(row): Bar => ({
				...row,
				color: colors.get(row.name) ?? "",
				widthPct: Math.max(BAR_MIN_PCT, row.value / max),
				pctOfTotal: total > 0 ? row.value / total : 0,
			}),
		)
	}, [source, valueField])

	// A list longer than the card scrolls inside it — rows never spill out of
	// the card (MAP-49), and every row stays reachable. A "+N more" footer names
	// what is still below the fold and goes away as the reader scrolls to it.
	const maxRows = height > 0 ? Math.max(1, Math.floor((height - MORE_ROW_H) / ROW_FULL_H)) : bars.length
	const truncated = bars.length > maxRows
	const visibleBars = bars
	const [scrollTop, setScrollTop] = React.useState(0)
	const hiddenCount = truncated
		? Math.max(0, bars.length - Math.floor((scrollTop + height - MORE_ROW_H + ROW_GAP) / ROW_FULL_H))
		: 0
	// Divide the measured height among the rows, bounded both ways.
	const rowH =
		height > 0 && !truncated
			? Math.min(
					ROW_MAX_H,
					Math.max(ROW_MIN_H, (height - ROW_GAP * (visibleBars.length - 1)) / visibleBars.length),
				)
			: ROW_MIN_H
	const barH = Math.round(
		BAR_MIN_THICKNESS +
			((BAR_MAX_THICKNESS - BAR_MIN_THICKNESS) * (rowH - ROW_MIN_H)) / (ROW_MAX_H - ROW_MIN_H),
	)

	const [hover, setHover] = React.useState<number | null>(null)

	if (bars.length === 0) {
		return (
			<div className={cn("relative h-full w-full grid place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	return (
		<div
			ref={containerRef}
			className={cn("relative h-full w-full select-none", className)}
			onPointerLeave={() => setHover(null)}
		>
			<div
				className={cn(
					"flex h-full w-full flex-col justify-start px-1",
					truncated
						? "overflow-y-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
						: "overflow-hidden",
				)}
				style={{ rowGap: ROW_GAP, paddingBottom: truncated ? MORE_ROW_H : 0 }}
				onScroll={(event) => setScrollTop(event.currentTarget.scrollTop)}
				data-slot="hbar-rows"
			>
				{visibleBars.map((bar, i) => {
					const isHover = hover === i
					const fade = hover !== null && !isHover ? 0.55 : 1
					return (
						<div
							key={`${bar.name}-${i}`}
							// Label / track / value: the value column is sized by its content
							// and right-aligned, so the numbers line up down the panel however
							// long the category names are.
							className="grid min-h-0 shrink-0 items-center gap-2 text-[11px] leading-none"
							style={{
								gridTemplateColumns: "minmax(0, 38%) 1fr max-content",
								height: rowH,
							}}
							onPointerEnter={() => setHover(i)}
						>
							<span
								className={cn(
									"truncate",
									bar.unnamed ? "italic text-muted-foreground" : "text-foreground/90",
								)}
								title={bar.name}
							>
								{bar.name}
							</span>
							<div
								className="relative w-full overflow-hidden rounded-[3px] bg-foreground/5"
								style={{ height: barH }}
							>
								<div
									className="absolute inset-y-0 left-0 rounded-[3px]"
									style={{
										width: `${bar.widthPct * 100}%`,
										backgroundColor: bar.color,
										opacity: fade,
										transition: "opacity 140ms ease, width 220ms ease",
									}}
								/>
							</div>
							<span className="shrink-0 text-right tabular-nums text-muted-foreground">
								<span className="text-foreground/90">{fmtValue(bar.value, unit)}</span>
								<span className="px-1 text-muted-foreground/50">·</span>
								<span>{fmtPct(bar.pctOfTotal)}</span>
							</span>
						</div>
					)
				})}
			</div>
			{hiddenCount > 0 && (
				<div
					className="pointer-events-none absolute inset-x-0 bottom-0 flex items-end bg-gradient-to-t from-card via-card/90 to-transparent px-1 pt-4 text-[10px] leading-none text-muted-foreground"
					style={{ height: MORE_ROW_H + 16 }}
					data-slot="hbar-more"
				>
					<span className="pb-px">+{hiddenCount} more · scroll</span>
				</div>
			)}
		</div>
	)
}
