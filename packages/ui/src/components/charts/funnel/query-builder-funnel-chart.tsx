import * as React from "react"

import type { BaseChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { funnelSampleData } from "../_shared/sample-data"
import { resolveSeriesColor } from "../../../lib/semantic-series-colors"

interface Row {
	name: string
	value: number
}

interface Stage extends Row {
	color: string
	/** Bar width as a fraction of the largest stage (0–1). */
	widthPct: number
	/** Share of the first stage's value (0–1). */
	pctOfFirst: number
	/** Conversion from the previous stage (0–1); 1 for the first stage. */
	pctOfPrev: number
}

function asFiniteNumber(value: unknown): number {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

function pickValueField(rows: ReadonlyArray<Record<string, unknown>>): string {
	if (rows.length === 0) return "value"
	const first = rows[0]
	for (const key of Object.keys(first)) {
		if (key === "name") continue
		if (typeof first[key] === "number") return key
	}
	return "value"
}

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

function fmtPct(fraction: number): string {
	const pct = fraction * 100
	return `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%`
}

const ROW_GAP = 6
const ROW_MIN_H = 22
const BAR_MIN_PCT = 0.04

export function QueryBuilderFunnelChart({ data, className, unit, funnel }: BaseChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> =
		Array.isArray(data) && data.length > 0
			? data
			: (funnelSampleData as ReadonlyArray<Record<string, unknown>>)

	const valueField = React.useMemo(() => pickValueField(source), [source])

	const stages = React.useMemo(() => {
		const rows: Row[] = source.map((row) => ({
			name: String(row.name ?? "—"),
			value: asFiniteNumber(row[valueField]),
		}))
		const max = rows.reduce((acc, r) => Math.max(acc, r.value), 0)
		const first = rows[0]?.value ?? 0
		if (max <= 0) return [] as Stage[]
		return rows.map((row, idx): Stage => {
			const prev = rows[idx - 1]?.value
			const color = resolveSeriesColor(row.name, idx)
			return {
				...row,
				color,
				widthPct: Math.max(BAR_MIN_PCT, row.value / max),
				pctOfFirst: first > 0 ? row.value / first : 0,
				pctOfPrev: idx === 0 ? 1 : prev && prev > 0 ? row.value / prev : 0,
			}
		})
	}, [source, valueField])

	const [hover, setHover] = React.useState<number | null>(null)
	const showStepPercent = funnel?.showStepPercent === true

	if (stages.length === 0) {
		return (
			<div className={cn("relative h-full w-full grid place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	return (
		<div
			className={cn("flex h-full w-full flex-col justify-center gap-1.5 px-1 select-none", className)}
			style={{ rowGap: ROW_GAP }}
			onPointerLeave={() => setHover(null)}
		>
			{stages.map((stage, i) => {
				const isHover = hover === i
				const fade = hover !== null && !isHover ? 0.55 : 1
				return (
					<div
						key={stage.name}
						className="flex min-h-0 flex-1 flex-col justify-center gap-0.5"
						style={{ minHeight: ROW_MIN_H }}
						onPointerEnter={() => setHover(i)}
					>
						{/* Label row */}
						<div className="flex items-baseline justify-between gap-2 text-[11px] leading-none">
							<span className="truncate text-foreground/90" title={stage.name}>
								{stage.name}
							</span>
							<span className="shrink-0 tabular-nums text-muted-foreground">
								<span className="text-foreground/90">{fmtValue(stage.value, unit)}</span>
								<span className="px-1 text-muted-foreground/50">·</span>
								<span>{fmtPct(stage.pctOfFirst)}</span>
								{showStepPercent && i > 0 && (
									<>
										<span className="px-1 text-muted-foreground/50">↓</span>
										<span>{fmtPct(stage.pctOfPrev)}</span>
									</>
								)}
							</span>
						</div>
						{/* Bar */}
						<div className="relative h-2.5 w-full overflow-hidden rounded-[3px] bg-foreground/5">
							<div
								className="absolute inset-y-0 left-0 rounded-[3px]"
								style={{
									width: `${stage.widthPct * 100}%`,
									backgroundColor: stage.color,
									opacity: fade,
									transition: "opacity 140ms ease, width 220ms ease",
								}}
							/>
						</div>
					</div>
				)
			})}
		</div>
	)
}
