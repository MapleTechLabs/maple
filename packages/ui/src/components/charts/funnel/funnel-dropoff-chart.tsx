import * as React from "react"

import type { QueryBuilderFunnelChartProps } from "../_shared/chart-types"
import { cn } from "../../../lib/utils"
import { formatNumber, formatValueByUnit } from "../../../lib/format"
import { asFiniteNumber, pickValueField, toBreakdownRows } from "../_shared/breakdown-rows"
import { resolveSeriesColors } from "../../../lib/semantic-series-colors"
import { useContainerSize } from "../../../hooks/use-container-size"

// The funnel's drop-off view: one column per step, read left to right.
//
// The solid bar is who reached the step; the hatched cap above it is who left
// since the previous one, so every column's top lines up with the previous
// column's bar and the gap between them IS the drop-off. The connector carries
// the step-to-step conversion and the median time between the two events, and
// hovering a step opens where its leavers went next. All of that arrives on
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
const STEP_MIN_W = 64
const CONNECTOR_W = 60
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

/** The hatched "who left" cap: absence, drawn as texture rather than a colour. */
const LOST_STYLE: React.CSSProperties = {
	backgroundImage:
		"repeating-linear-gradient(135deg, color-mix(in oklab, currentColor 12%, transparent) 0 1px, transparent 1px 6px)",
	backgroundColor: "color-mix(in oklab, currentColor 3%, transparent)",
}

export function FunnelDropoffChart({ data, className, unit, showStepPercent }: QueryBuilderFunnelChartProps) {
	const source: ReadonlyArray<Record<string, unknown>> = Array.isArray(data) ? data : EMPTY_ROWS
	const valueField = React.useMemo(() => pickValueField(source), [source])
	const { steps, legend } = React.useMemo(() => toSteps(source, valueField), [source, valueField])

	const containerRef = React.useRef<HTMLDivElement>(null)
	const { width } = useContainerSize(containerRef)
	const [hover, setHover] = React.useState<number | null>(null)

	// Columns that fit: each step past the first costs a connector too.
	const maxSteps =
		width > 0 ? Math.max(1, Math.floor((width + CONNECTOR_W) / (STEP_MIN_W + CONNECTOR_W))) : steps.length
	const visible = steps.slice(0, maxSteps)
	const hidden = steps.length - visible.length
	const isGrouped = legend.length > 0
	const showPercent = showStepPercent !== false

	if (steps.length === 0 || (steps[0]?.value ?? 0) <= 0) {
		return (
			<div className={cn("relative grid h-full w-full place-items-center", className)}>
				<span className="text-[11px] text-muted-foreground">No data</span>
			</div>
		)
	}

	const hovered = hover !== null && hover > 0 ? visible[hover] : undefined
	const hoveredPrev = hover !== null && hover > 0 ? visible[hover - 1] : undefined
	// The tooltip sits right of the hovered column, or left of it near the edge.
	const columnW = width > 0 ? (width - CONNECTOR_W * (visible.length - 1)) / visible.length : 0
	const hoverLeft = hover === null ? 0 : hover * (columnW + CONNECTOR_W)
	const tipLeft =
		hover === null
			? 0
			: hoverLeft + columnW + 8 + TIP_W <= width
				? hoverLeft + columnW + 8
				: Math.max(0, hoverLeft - TIP_W - 8)

	const gridTemplateColumns = visible
		.map((_, index) => (index === 0 ? "minmax(0, 1fr)" : `${CONNECTOR_W}px minmax(0, 1fr)`))
		.join(" ")

	return (
		<div
			ref={containerRef}
			className={cn("relative flex h-full w-full flex-col overflow-hidden px-1 select-none", className)}
			onPointerLeave={() => setHover(null)}
			data-slot="funnel-dropoff"
		>
			{isGrouped && (
				<div className="flex shrink-0 flex-wrap items-center gap-x-3 gap-y-0.5 pb-1 text-[10px] leading-none text-muted-foreground">
					{legend.map((entry) => (
						<span key={entry.name} className="flex min-w-0 items-center gap-1" title={entry.name}>
							<span
								className="size-2 shrink-0 rounded-[2px]"
								style={{ backgroundColor: entry.color }}
							/>
							<span className="truncate">{entry.name}</span>
						</span>
					))}
				</div>
			)}
			<div className="grid min-h-0 flex-1" style={{ gridTemplateColumns }}>
				{visible.map((step, index) => {
					const prev = visible[index - 1]
					const isHover = hover === index
					const fade = hover !== null && !isHover ? 0.55 : 1
					return (
						<React.Fragment key={`${step.name}-${index}`}>
							{index > 0 && (
								<div className="flex min-w-0 flex-col items-center justify-end overflow-hidden px-1 pb-[42px] whitespace-nowrap">
									{showPercent && step.ofPrev !== null && (
										<span className="text-[11px] font-semibold leading-none tabular-nums text-foreground/90">
											{fmtPct(step.ofPrev)}
										</span>
									)}
									<span className="relative my-1 h-px w-full bg-border">
										<span className="absolute -top-[2.5px] right-0 size-[5px] rotate-45 border-t border-r border-muted-foreground" />
									</span>
									{step.p50Ms !== undefined && (
										<span
											className="text-[10px] leading-none tabular-nums text-muted-foreground"
											title="Median time from the previous step"
										>
											{fmtSpan(step.p50Ms)}
										</span>
									)}
								</div>
							)}
							<div
								className="flex min-w-0 flex-col"
								onPointerEnter={() => setHover(index)}
								data-slot="funnel-dropoff-step"
							>
								<div className="flex h-4 items-baseline gap-1.5 text-[11px] leading-none">
									<span className="text-[10px] text-muted-foreground">{index + 1}</span>
									<span
										className={cn(
											"truncate",
											step.unnamed
												? "italic text-muted-foreground"
												: "text-foreground/90",
										)}
										title={step.name}
									>
										{step.name}
									</span>
								</div>
								<div
									className="relative mt-1.5 min-h-0 flex-1"
									style={{ opacity: fade, transition: "opacity 140ms ease" }}
								>
									{isGrouped ? (
										<div className="flex h-full items-end gap-0.5">
											{step.groups.map((group) => {
												const max = steps[0]?.value ?? 1
												const h = group.value / max
												const capH = Math.max(0, (group.prev - group.value) / max)
												return (
													<div
														key={group.name}
														className="relative h-full flex-1"
														title={`${group.name} · ${fmtValue(group.value, unit)}`}
													>
														{index > 0 && capH > 0 && (
															<div
																className="absolute inset-x-0 rounded-t-[3px] text-foreground"
																style={{
																	...LOST_STYLE,
																	bottom: `${h * 100}%`,
																	height: `${capH * 100}%`,
																}}
															/>
														)}
														<div
															className="absolute inset-x-0 bottom-0 rounded-t-[3px]"
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
											{prev && step.ofFirst < prev.ofFirst && (
												<div
													className="absolute inset-x-0 rounded-t-[4px] text-foreground"
													style={{
														...LOST_STYLE,
														bottom: `${step.ofFirst * 100}%`,
														height: `${(prev.ofFirst - step.ofFirst) * 100}%`,
													}}
													data-slot="funnel-dropoff-lost"
												/>
											)}
											<div
												className="absolute inset-x-0 bottom-0 rounded-t-[4px] bg-[var(--chart-2)]"
												style={{
													height: `${Math.max(step.ofFirst * 100, step.value > 0 ? 1.5 : 0)}%`,
													transition: "height 220ms ease",
												}}
												data-slot="funnel-dropoff-bar"
											/>
											{prev && step.ofFirst < prev.ofFirst && (
												<div
													className="absolute inset-x-0 h-0.5 bg-card"
													style={{ bottom: `${step.ofFirst * 100}%` }}
												/>
											)}
										</>
									)}
								</div>
								<div className="mt-1.5 flex flex-col gap-px text-[11px] leading-tight">
									<div className="truncate tabular-nums">
										<span className="font-medium text-foreground/90">
											{fmtValue(step.value, unit)}
										</span>
										{showPercent && (
											<span className="ml-1.5 text-muted-foreground">
												{fmtPct(step.ofFirst)}
											</span>
										)}
									</div>
									<div className="truncate text-[10px] tabular-nums text-muted-foreground">
										{prev
											? `−${fmtValue(step.dropped, unit)} dropped${showPercent && prev.value > 0 ? ` · ${fmtPct(step.dropped / prev.value)}` : ""}`
											: "entered"}
									</div>
								</div>
							</div>
						</React.Fragment>
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
						{hoveredPrev.name} → {hoveredPrev && hovered.name}
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
