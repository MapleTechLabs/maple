import * as React from "react"

import type { QueryBuilderFunnelChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { asFiniteNumber, pickValueField, toBreakdownRows } from "../_shared/breakdown-rows"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { useContainerSize } from "../../../hooks/use-container-size"
import { ArrowDownIcon, ArrowRightIcon, CircleCheckIcon } from "../../icons"

// The funnel's drop-off view: one column per step, read left to right.
//
// Each column is headed by its share of the first step and its count. The
// solid bar is who reached the step; the faint block above it is the previous
// step's level, so the gap between them IS the drop-off. A pill at the foot of
// the bar carries the step-to-step conversion, the loss, and the median time
// between the two events, and hovering a step opens where its leavers went. All of that arrives on
// the same `{ name, value }` rows the bar funnel draws, as optional per-step
// fields (`p50Ms`, `p90Ms`, `leavers`) the route adds only for this view.

interface Leaver {
	name: string
	count: number
}

interface Step {
	name: string
	unnamed: boolean
	value: number
	/** Share of the first step, 0–1. */
	ofFirst: number
	/** Conversion from the previous step, 0–1; null on step 1 or after a zero step. */
	ofPrev: number | null
	/** Persons lost since the previous step. */
	dropped: number
	p50Ms?: number
	p90Ms?: number
	leavers: ReadonlyArray<Leaver>
	/** One thin bar per breakdown group; empty without a breakdown. */
	groups: ReadonlyArray<{ name: string; color: string; value: number; prev: number }>
}

/** How many leavers the tooltip names; the remainder folds into "Other". */
const LEAVERS_SHOWN = 4
/** Narrowest useful step column; past that the tail folds into "+N more". */
const STEP_MIN_W = 76
const TIP_W = 264
const ENDED_LABEL = "Nothing after"

const EMPTY_ROWS: ReadonlyArray<Record<string, unknown>> = []

function fmtValue(value: number, unit?: string): string {
	return unit ? formatValueByUnit(value, unit) : formatNumber(value)
}

function fmtPct(fraction: number): string {
	const pct = fraction * 100
	return `${pct.toFixed(pct < 10 && pct > 0 ? 1 : 0)}%`
}

/** Coarse, human durations: the reader wants "2d 3h", not "51.2h". */
function fmtSpan(ms: number): string {
	if (!Number.isFinite(ms) || ms <= 0) return "—"
	const s = Math.round(ms / 1000)
	if (s < 60) return `${s}s`
	const m = Math.round(s / 60)
	if (m < 60) return `${m}m`
	const h = Math.floor(m / 60)
	if (h < 24) return m % 60 === 0 ? `${h}h` : `${h}h ${m % 60}m`
	const d = Math.floor(h / 24)
	return h % 24 === 0 ? `${d}d` : `${d}d ${h % 24}h`
}

function toLeavers(value: unknown): ReadonlyArray<Leaver> {
	if (!Array.isArray(value)) return []
	return value
		.filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
		.map((entry) => ({
			name: typeof entry.name === "string" ? entry.name : "",
			count: asFiniteNumber(entry.count),
		}))
		.filter((entry) => entry.count > 0)
}

function optionalNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : undefined
}

function isGroupedRow(row: Record<string, unknown>): row is Record<string, unknown> & { group: string } {
	return typeof row.group === "string"
}

/** Fold the rows into steps, grouped or plain. */
function toSteps(
	source: ReadonlyArray<Record<string, unknown>>,
	valueField: string,
): {
	steps: Step[]
	legend: ReadonlyArray<{ name: string; color: string }>
} {
	const groupedRows = source.filter(isGroupedRow)
	if (groupedRows.length > 0 && groupedRows.length === source.length) {
		const groups: string[] = []
		const byName = new Map<string, { value: number; byGroup: Map<string, number> }>()
		const order: string[] = []
		for (const row of groupedRows) {
			if (!groups.includes(row.group)) groups.push(row.group)
			const raw = row.name == null ? "" : String(row.name).trim()
			const name = raw === "" ? "(no value)" : raw
			let step = byName.get(name)
			if (!step) {
				step = { value: 0, byGroup: new Map() }
				byName.set(name, step)
				order.push(name)
			}
			const value = asFiniteNumber(row[valueField])
			step.byGroup.set(row.group, (step.byGroup.get(row.group) ?? 0) + value)
			step.value += value
		}
		const colors = resolveSeriesColors(groups)
		const first = byName.get(order[0] ?? "")?.value ?? 0
		const steps = order.map((name, index): Step => {
			// `order` and `byName` are filled together above, so every name resolves.
			const step = byName.get(name) ?? { value: 0, byGroup: new Map<string, number>() }
			const prev = index > 0 ? byName.get(order[index - 1] ?? "") : undefined
			return {
				name,
				unnamed: name === "(no value)",
				value: step.value,
				ofFirst: first > 0 ? step.value / first : 0,
				ofPrev: prev && prev.value > 0 ? step.value / prev.value : null,
				dropped: prev ? Math.max(0, prev.value - step.value) : 0,
				leavers: [],
				groups: groups.map((group) => ({
					name: group,
					color: colors.get(group) ?? "",
					value: step.byGroup.get(group) ?? 0,
					prev: prev?.byGroup.get(group) ?? step.byGroup.get(group) ?? 0,
				})),
			}
		})
		return { steps, legend: groups.map((name) => ({ name, color: colors.get(name) ?? "" })) }
	}

	const rows = toBreakdownRows(source, valueField)
	const first = rows[0]?.value ?? 0
	return {
		legend: [],
		steps: rows.map((row, index): Step => {
			const raw = source[index] ?? {}
			const prev = rows[index - 1]
			return {
				...row,
				ofFirst: first > 0 ? row.value / first : 0,
				ofPrev: prev && prev.value > 0 ? row.value / prev.value : null,
				dropped: prev ? Math.max(0, prev.value - row.value) : 0,
				p50Ms: optionalNumber(raw.p50Ms),
				p90Ms: optionalNumber(raw.p90Ms),
				leavers: toLeavers(raw.leavers),
				groups: [],
			}
		}),
	}
}

/** The ghost of the previous step's level: what was here, drawn as absence. */
const LOST_CLASS = "bg-foreground/[0.06]"

/** Narrowest useful step column; past that the tail folds into "+N more". */
const STEP_GAP = 12
// The pill sheds segments before it clips: the median time goes first, then
// the loss, so a narrow column still states the conversion whole.
const PILL_TIME_MIN_W = 150
const PILL_LOSS_MIN_W = 104

export function FunnelDropoffChart({ data, className, unit, showStepPercent }: QueryBuilderFunnelChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS
	const valueField = React.useMemo(() => pickValueField(source), [source])
	const { steps, legend } = React.useMemo(() => toSteps(source, valueField), [source, valueField])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width } = useContainerSize(containerRef)
	const [hover, setHover] = React.useState<number | null>(null)

	const isGrouped = legend.length > 0
	const showPercent = showStepPercent !== false

	// Columns that fit: each step past the first costs a gap too.
	const maxSteps =
		width > 0 ? Math.max(1, Math.floor((width + STEP_GAP) / (STEP_MIN_W + STEP_GAP))) : steps.length
	const visible = steps.slice(0, maxSteps)
	const hidden = steps.length - visible.length

	if (steps.length === 0 || (steps[0]?.value ?? 0) <= 0) {
		return (
			<div className={cn("relative grid h-full w-full place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	const first = steps[0]
	const last = steps[steps.length - 1]
	const hovered = hover !== null && hover > 0 ? visible[hover] : undefined
	const hoveredPrev = hover !== null && hover > 0 ? visible[hover - 1] : undefined
	// The tooltip sits right of the hovered column, or left of it near the edge.
	const columnW = width > 0 ? (width - STEP_GAP * (visible.length - 1)) / visible.length : 0
	const hoverLeft = hover === null ? 0 : hover * (columnW + STEP_GAP)
	const tipLeft =
		hover === null
			? 0
			: hoverLeft + columnW + 8 + TIP_W <= width
				? hoverLeft + columnW + 8
				: Math.max(0, hoverLeft - TIP_W - 8)
	const pillTime = columnW === 0 || columnW >= PILL_TIME_MIN_W
	const pillLoss = columnW === 0 || columnW >= PILL_LOSS_MIN_W

	return (
		<div
			ref={containerRef}
			className={cn("relative flex h-full w-full flex-col overflow-hidden px-1 select-none", className)}
			onPointerLeave={() => setHover(null)}
			data-slot="funnel-dropoff"
		>
			<div className="flex shrink-0 items-baseline justify-between gap-3 pb-2 text-[10px] leading-none">
				{isGrouped ? (
					<div className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-0.5 text-muted-foreground">
						{legend.map((entry) => (
							<span
								key={entry.name}
								className="flex min-w-0 items-center gap-1"
								title={entry.name}
							>
								<span
									className="size-2 shrink-0 rounded-[2px]"
									style={{ backgroundColor: entry.color }}
								/>
								<span className="truncate">{entry.name}</span>
							</span>
						))}
					</div>
				) : (
					<span />
				)}
				{first && last && steps.length > 1 && (
					<span
						className="flex shrink-0 items-baseline gap-1.5 tabular-nums whitespace-nowrap"
						data-slot="funnel-dropoff-summary"
					>
						<span className="text-muted-foreground">
							{showPercent ? "Conversion rate" : "Converted"}
						</span>
						<span className="text-[11px] font-semibold text-foreground">
							{showPercent
								? fmtPct(last.ofFirst)
								: `${fmtValue(last.value, unit)} of ${fmtValue(first.value, unit)}`}
						</span>
					</span>
				)}
			</div>
			<div
				className="grid min-h-0 flex-1"
				style={{
					gridTemplateColumns: `repeat(${visible.length}, minmax(0, 1fr))`,
					columnGap: STEP_GAP,
				}}
			>
				{visible.map((step, index) => {
					const prev = visible[index - 1]
					const isHover = hover === index
					const fade = hover !== null && !isHover ? 0.6 : 1
					const capH = prev ? Math.max(0, prev.ofFirst - step.ofFirst) : 0
					const lostShare = prev && prev.value > 0 ? step.dropped / prev.value : 0
					const isLast = index === steps.length - 1
					return (
						<div
							key={`${step.name}-${index}`}
							className="flex min-w-0 flex-col"
							onPointerEnter={() => setHover(index)}
							data-slot="funnel-dropoff-step"
						>
							<div className="flex flex-col gap-1 leading-none">
								<span
									className={cn(
										"truncate text-[11px] font-medium",
										step.unnamed ? "italic text-muted-foreground" : "text-foreground/90",
									)}
									title={step.name}
								>
									{step.name}
								</span>
								<span className="truncate text-base font-semibold tabular-nums text-foreground">
									{showPercent ? fmtPct(step.ofFirst) : fmtValue(step.value, unit)}
								</span>
								<span className="truncate text-[11px] tabular-nums text-muted-foreground">
									{showPercent
										? fmtValue(step.value, unit)
										: index === 0
											? "entered"
											: "reached"}
								</span>
							</div>
							<div
								className="relative mt-2.5 min-h-0 flex-1"
								style={{ opacity: fade, transition: "opacity 140ms ease" }}
							>
								{isGrouped ? (
									<div className="flex h-full items-end gap-0.5">
										{step.groups.map((group) => {
											const max = steps[0]?.value ?? 1
											const h = group.value / max
											const groupCapH = Math.max(0, (group.prev - group.value) / max)
											return (
												<div
													key={group.name}
													className="relative h-full flex-1"
													title={`${group.name} · ${fmtValue(group.value, unit)}`}
												>
													{index > 0 && groupCapH > 0 && (
														<div
															className={cn(
																"absolute inset-x-0 rounded-[3px]",
																LOST_CLASS,
															)}
															style={{
																bottom: `${h * 100}%`,
																height: `${groupCapH * 100}%`,
															}}
														/>
													)}
													<div
														className="absolute inset-x-0 bottom-0 rounded-[3px]"
														style={{
															height: `${h * 100}%`,
															backgroundColor: group.color,
														}}
													/>
												</div>
											)
										})}
									</div>
								) : (
									<>
										{prev && capH > 0 && (
											<div
												className={cn("absolute inset-x-0 rounded-[4px]", LOST_CLASS)}
												style={{
													bottom: `${step.ofFirst * 100}%`,
													height: `${capH * 100}%`,
												}}
												data-slot="funnel-dropoff-lost"
											/>
										)}
										<div
											className="absolute inset-x-0 bottom-0 rounded-[4px] bg-[var(--chart-2)]"
											style={{
												height: `${Math.max(step.ofFirst * 100, step.value > 0 ? 1.5 : 0)}%`,
												transition: "height 220ms ease",
											}}
											data-slot="funnel-dropoff-bar"
										/>
									</>
								)}
								{prev && showPercent && step.ofPrev !== null && (
									<span
										className="absolute bottom-1.5 left-1.5 flex items-center gap-2 rounded-md bg-card/95 px-1.5 py-1 text-[11px] leading-none tabular-nums whitespace-nowrap shadow-xs ring-1 ring-border/60"
										data-slot="funnel-dropoff-pill"
									>
										<span className="flex items-center gap-1 font-semibold text-foreground">
											{isLast ? (
												<CircleCheckIcon size={12} className="text-success" />
											) : (
												<ArrowRightIcon size={12} className="text-success" />
											)}
											{fmtPct(step.ofPrev)}
										</span>
										{pillLoss && lostShare > 0 && (
											<span className="flex items-center gap-1 text-foreground/80">
												<ArrowDownIcon size={12} className="text-destructive" />
												{fmtPct(lostShare)}
											</span>
										)}
										{pillTime && step.p50Ms !== undefined && (
											<span
												className="text-muted-foreground"
												title="Median time from the previous step"
											>
												{fmtSpan(step.p50Ms)}
											</span>
										)}
									</span>
								)}
							</div>
						</div>
					)
				})}
			</div>
			{hidden > 0 && (
				<div className="shrink-0 pt-1 text-[10px] leading-none text-muted-foreground">
					+{hidden} more
				</div>
			)}
			{hovered && hoveredPrev && !isGrouped && (
				<div
					className="pointer-events-none absolute top-5 z-10 rounded-lg border bg-popover px-2.5 py-2 text-[11px] shadow-md"
					style={{ left: tipLeft, width: TIP_W }}
					data-slot="funnel-dropoff-tooltip"
				>
					<div className="mb-1 truncate text-muted-foreground">
						{hoveredPrev.name} → {hovered.name}
					</div>
					<Row
						label="converted"
						value={`${fmtValue(hovered.value, unit)} · ${fmtPct(hovered.ofPrev ?? 0)}`}
					/>
					<Row
						label="dropped"
						value={`${fmtValue(hovered.dropped, unit)} · ${hoveredPrev.value > 0 ? fmtPct(hovered.dropped / hoveredPrev.value) : "—"}`}
					/>
					{hovered.p50Ms !== undefined && (
						<Row
							label="time between"
							value={`p50 ${fmtSpan(hovered.p50Ms)}${hovered.p90Ms !== undefined ? ` · p90 ${fmtSpan(hovered.p90Ms)}` : ""}`}
						/>
					)}
					{hovered.leavers.length > 0 && hovered.dropped > 0 && (
						<>
							<div className="-mx-2.5 my-1.5 h-px bg-border" />
							<div className="mb-1 text-[10px] uppercase tracking-wider text-muted-foreground">
								Dropped here went to
							</div>
							{leaverRows(hovered.leavers, hovered.dropped).map((entry) => (
								<div key={entry.name} className="my-0.5">
									<div className="flex items-center gap-2">
										<span
											className={cn(
												"min-w-0 flex-1 truncate",
												entry.ended && "text-muted-foreground",
											)}
										>
											{entry.name}
										</span>
										<span className="tabular-nums text-muted-foreground">
											{fmtPct(entry.share)}
										</span>
									</div>
									<div className="relative mt-0.5 h-1 rounded-sm bg-foreground/5">
										<div
											className="absolute inset-y-0 left-0 rounded-sm bg-foreground/35"
											style={{ width: `${entry.share * 100}%` }}
										/>
									</div>
								</div>
							))}
						</>
					)}
				</div>
			)}
		</div>
	)
}

function Row({ label, value }: { label: string; value: string }) {
	return (
		<div className="flex justify-between gap-3 tabular-nums">
			<span className="text-muted-foreground">{label}</span>
			<span className="truncate text-foreground/90">{value}</span>
		</div>
	)
}

/** The top leavers as shares of everyone who dropped, the remainder as "Other". */
function leaverRows(leavers: ReadonlyArray<Leaver>, dropped: number) {
	const shown = leavers.slice(0, LEAVERS_SHOWN)
	const named = shown.reduce((acc, entry) => acc + entry.count, 0)
	const rows = shown.map((entry) => ({
		name: entry.name === "" ? ENDED_LABEL : entry.name,
		ended: entry.name === "",
		share: Math.min(1, entry.count / dropped),
	}))
	const rest = dropped - named
	if (rest > 0 && leavers.length > LEAVERS_SHOWN)
		rows.push({ name: "Other", ended: true, share: rest / dropped })
	return rows
}
