import { DateTime, Option } from "effect"
import { formatNumber, formatValueByUnit } from "@maple/ui/lib/format"
import { resolveSequentialDomain, type SequentialScaleType } from "./sequential-domain"

// The model half of `QueryBuilderHeatmapChart` (packages/ui/src/components/charts/heatmap/
// query-builder-heatmap-chart.tsx): points, the pruned grid, holes, ramp positions and labels.

export interface HeatmapPoint {
	readonly x: string
	readonly y: string
	readonly value: number
}

/** A cell with a value, or a hole with none (holes are focusable data). */
export interface HeatmapSlot {
	readonly x: string
	readonly y: string
	readonly value: number | null
}

type Row = Readonly<Record<string, unknown>>

const asFiniteNumber = (value: unknown): number => {
	const parsed = typeof value === "number" ? value : Number(value)
	return Number.isFinite(parsed) ? parsed : 0
}

export const deriveHeatmapPoints = (rows: ReadonlyArray<Row>): ReadonlyArray<HeatmapPoint> => {
	const first = rows[0]
	if (first === undefined) return []
	if ("x" in first && "y" in first && "value" in first)
		return rows.map((row) => ({
			x: String(row.x ?? ""),
			y: String(row.y ?? ""),
			value: asFiniteNumber(row.value),
		}))
	const numericKeys = Object.keys(first).filter(
		(k) => k !== "name" && k !== "bucket" && typeof first[k] === "number",
	)
	const labelKey = "name" in first ? "name" : "bucket" in first ? "bucket" : null
	if (labelKey === null || numericKeys.length === 0) return []
	return rows.flatMap((row) =>
		numericKeys.map((xKey) => ({
			x: xKey,
			y: String(row[labelKey] ?? ""),
			value: asFiniteNumber(row[xKey]),
		})),
	)
}

export interface HeatmapModel {
	readonly xDomain: ReadonlyArray<string>
	readonly yDomain: ReadonlyArray<string>
	readonly cells: ReadonlyArray<HeatmapSlot>
	readonly holes: ReadonlyArray<HeatmapSlot>
	readonly domain: readonly [number, number]
	readonly span: number
	readonly hiddenX: number
	readonly hiddenY: number
}

const EMPTY_MODEL: HeatmapModel = {
	xDomain: [],
	yDomain: [],
	cells: [],
	holes: [],
	domain: [0, 1],
	span: 0,
	hiddenX: 0,
	hiddenY: 0,
}

/** `buildModel`: all-zero axes pruned (and counted), y reversed, the cross-product split into cells and holes. */
export const buildHeatmapModel = (points: ReadonlyArray<HeatmapPoint>): HeatmapModel => {
	if (points.length === 0) return EMPTY_MODEL
	const xs = [...new Set(points.map((p) => p.x))]
	const ys = [...new Set(points.map((p) => p.y))]
	const live = points.filter((p) => p.value !== 0)
	const liveX = new Set(live.map((p) => p.x))
	const liveY = new Set(live.map((p) => p.y))
	const keptX = xs.filter((x) => liveX.has(x))
	const keptY = ys.filter((y) => liveY.has(y))
	const pruned = keptX.length > 0 && keptY.length > 0
	const xDomain = pruned ? keptX : xs
	const yDomain = [...(pruned ? keptY : ys)].reverse()
	const slotKey = (x: string, y: string) => `${x}\u0000${y}`
	const lookup = new Map(points.map((point) => [slotKey(point.x, point.y), point.value]))
	const slots = xDomain.flatMap((x) =>
		yDomain.map((y): HeatmapSlot => ({ x, y, value: lookup.get(slotKey(x, y)) ?? null })),
	)
	const cells = slots.filter((slot) => slot.value !== null)
	const values = cells.flatMap((slot) => (slot.value === null ? [] : [slot.value]))
	const min = values.length > 0 ? Math.min(...values) : 0
	const max = values.length > 0 ? Math.max(...values) : 1
	const span = max - min
	return {
		xDomain,
		yDomain,
		cells,
		holes: slots.filter((slot) => slot.value === null),
		domain: span > 0 ? [min, max] : [min, min + 1],
		span,
		hiddenX: pruned ? xs.length - keptX.length : 0,
		hiddenY: pruned ? ys.length - keptY.length : 0,
	}
}

const clamp = (value: number, lo: number, hi: number): number =>
	Number.isFinite(value) ? Math.max(lo, Math.min(hi, value)) : lo

const clamp01 = (value: number): number => clamp(value, 0, 1)

/** The data value at parametric position `t` along the ramp (linear in value, or in log value). */
export const valueAtRampPosition = (
	t: number,
	domain: readonly [number, number],
	scaleType: SequentialScaleType,
): number => {
	const [lo, hi] = resolveSequentialDomain(domain, scaleType)
	if (hi <= lo) return lo
	return scaleType === "log" ? lo * (hi / lo) ** clamp01(t) : lo + clamp01(t) * (hi - lo)
}

export const rampPositionOf = (
	value: number,
	domain: readonly [number, number],
	scaleType: SequentialScaleType,
): number => {
	const [lo, hi] = resolveSequentialDomain(domain, scaleType)
	if (hi <= lo) return 0
	return scaleType === "log"
		? clamp01(Math.log(Math.max(value, lo) / lo) / Math.log(hi / lo))
		: clamp01((value - lo) / (hi - lo))
}

export const formatScalar = (value: number, unit?: string): string =>
	unit !== undefined && unit !== "" ? formatValueByUnit(value, unit) : formatNumber(value)

/** `roundTick`: integers when the range is integral, three significant figures otherwise. */
export const roundTick = (value: number, min: number, span: number): number => {
	if (Number.isInteger(min) && Number.isInteger(min + span)) return Math.round(value)
	if (value === 0) return 0
	const magnitude = Math.floor(Math.log10(Math.abs(value)))
	const factor = 10 ** (2 - magnitude)
	return Math.round(value * factor) / factor
}

export const ISO_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z?$/

/** `clockLabel`: `HH:MM` of an ISO timestamp in `timeZone`. */
const clockLabel = (iso: string, timeZone: string | undefined): string =>
	Option.match(DateTime.make(iso), {
		onNone: () => iso,
		onSome: (date) =>
			new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hour12: false })
				.format(DateTime.toEpochMillis(date))
				.replace(/^24:/, "00:"),
	})

export const shortenYLabel = (raw: string, allIso: boolean, timeZone: string | undefined): string =>
	allIso ? clockLabel(raw, timeZone) : raw

export const truncateYLabel = (label: string, maxChars: number): string =>
	label.length <= maxChars ? label : `${label.slice(0, Math.max(1, maxChars - 1))}…`
