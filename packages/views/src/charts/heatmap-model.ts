import { DateTime, Option, Order, Array as Arr, Record as Rec, String as Str } from "effect"
import { cellText } from "./series/breakdown-rows"
import { formatNumber, formatValueByUnit } from "@maple/ui/lib/format"
import { resolveSequentialDomain, type SequentialScaleType } from "./sequential-domain"

// The query-builder heatmap's model: points, the pruned grid, holes, ramp positions
// and labels.

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
		return Arr.map(rows, (row) => ({
			x: cellText(row.x),
			y: cellText(row.y),
			value: asFiniteNumber(row.value),
		}))
	const numericKeys = Arr.filter(
		Rec.keys(first),
		(k) => k !== "name" && k !== "bucket" && typeof first[k] === "number",
	)
	const labelKey = "name" in first ? "name" : "bucket" in first ? "bucket" : null
	if (labelKey === null || numericKeys.length === 0) return []
	return Arr.flatMap(rows, (row) =>
		Arr.map(numericKeys, (xKey) => ({
			x: xKey,
			y: cellText(row[labelKey]),
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

/** All-zero axes pruned (and counted), y reversed, the cross-product split into cells and holes. */
/** ISO columns by the instant they name; `.500Z` sorts after the whole second, not before. */
const byInstant: Order.Order<string> = Order.mapInput(Order.Number, (iso: string) =>
	Option.match(DateTime.make(iso), { onNone: () => 0, onSome: DateTime.toEpochMillis }),
)

export const buildHeatmapModel = (
	points: ReadonlyArray<HeatmapPoint>,
	/** Every column in order, empty ones included (a time grid); none of them is pruned. */
	fullXDomain?: ReadonlyArray<string>,
): HeatmapModel => {
	if (points.length === 0) return EMPTY_MODEL
	// Time columns read left to right whatever order the rows came in.
	const seenX = [...new Set(Arr.map(points, (p) => p.x))]
	const xs = Arr.every(seenX, (x) => ISO_RE.test(x)) ? Arr.sort(seenX, byInstant) : seenX
	const ys = [...new Set(Arr.map(points, (p) => p.y))]
	const live = Arr.filter(points, (p) => p.value !== 0)
	const liveX = new Set(Arr.map(live, (p) => p.x))
	const liveY = new Set(Arr.map(live, (p) => p.y))
	const keptX = Arr.filter(xs, (x) => liveX.has(x))
	const keptY = Arr.filter(ys, (y) => liveY.has(y))
	const pruned = keptX.length > 0 && keptY.length > 0
	const xDomain = fullXDomain ?? (pruned ? keptX : xs)
	const yDomain = [...(pruned ? keptY : ys)].reverse()
	const slotKey = (x: string, y: string) => `${x}\u0000${y}`
	const lookup = new Map(Arr.map(points, (point) => [slotKey(point.x, point.y), point.value]))
	const slots = Arr.flatMap(xDomain, (x) =>
		Arr.map(yDomain, (y): HeatmapSlot => ({ x, y, value: lookup.get(slotKey(x, y)) ?? null })),
	)
	const cells = Arr.filter(slots, (slot) => slot.value !== null)
	const values = Arr.flatMap(cells, (slot) => (slot.value === null ? [] : [slot.value]))
	const min = values.length > 0 ? Math.min(...values) : 0
	const max = values.length > 0 ? Math.max(...values) : 1
	const span = max - min
	return {
		xDomain,
		yDomain,
		cells,
		holes: Arr.filter(slots, (slot) => slot.value === null),
		domain: span > 0 ? [min, max] : [min, min + 1],
		span,
		hiddenX: fullXDomain === undefined && pruned ? xs.length - keptX.length : 0,
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

/** `HH:MM` of an ISO timestamp in `timeZone`. */
const clockLabel = (iso: string, timeZone: string | undefined): string =>
	Option.match(DateTime.make(iso), {
		onNone: () => iso,
		onSome: (date) =>
			Str.replace(
				/^24:/,
				"00:",
			)(
				new Intl.DateTimeFormat("en-GB", {
					timeZone,
					hour: "2-digit",
					minute: "2-digit",
					hour12: false,
				}).format(DateTime.toEpochMillis(date)),
			),
	})

export const shortenYLabel = (raw: string, allIso: boolean, timeZone: string | undefined): string =>
	allIso ? clockLabel(raw, timeZone) : raw

/** A time cell's tooltip: the day and clock time, to the second when the time has seconds. */
export const timeTooltipLabel = (iso: string, timeZone: string | undefined): string =>
	Option.match(DateTime.make(iso), {
		onNone: () => iso,
		onSome: (date) => {
			const ms = DateTime.toEpochMillis(date)
			const withSeconds = Math.floor(ms / 1000) % 60 !== 0
			return `${dayLabel(iso, timeZone)} ${new Intl.DateTimeFormat("en-GB", {
				timeZone,
				hour: "2-digit",
				minute: "2-digit",
				...(withSeconds ? { second: "2-digit" } : undefined),
				hourCycle: "h23",
			}).format(ms)}`
		},
	})

/** The calendar day of an ISO timestamp in `timeZone`, e.g. `22 Nov`. */
const dayLabel = (iso: string, timeZone: string | undefined): string =>
	Option.match(DateTime.make(iso), {
		onNone: () => "",
		onSome: (date) =>
			new Intl.DateTimeFormat("en-GB", { timeZone, day: "numeric", month: "short" }).format(
				DateTime.toEpochMillis(date),
			),
	})

/**
 * Time-column labels: `HH:MM` while every column is on one day in `timeZone`, else the day too
 * (`22 Nov 00:00`), so a 7-day window does not repeat one clock time per day.
 */
export const timeColumnLabeler = (
	columns: ReadonlyArray<string>,
	timeZone: string | undefined,
): ((iso: string) => string) => {
	const days = new Set(Arr.map(columns, (iso) => dayLabel(iso, timeZone)))
	return days.size > 1
		? (iso) => `${dayLabel(iso, timeZone)} ${clockLabel(iso, timeZone)}`
		: (iso) => clockLabel(iso, timeZone)
}

/** Clock steps a time axis labels at, in minutes; each lands on round local times. */
const TICK_STEPS_MIN = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720, 1440] as const
const TICK_CHAR_PX = 6.5
const TICK_GAP_PX = 16

/** Minutes since local midnight of an epoch ms in `timeZone`. */
const localMinuteOfDay = (ms: number, timeZone: string | undefined): number => {
	const parts = new Intl.DateTimeFormat("en-GB", {
		timeZone,
		hour: "2-digit",
		minute: "2-digit",
		hourCycle: "h23",
	}).formatToParts(ms)
	const part = (type: "hour" | "minute") =>
		Number(
			Option.getOrElse(
				Option.map(
					Arr.findFirst(parts, (p) => p.type === type),
					(p) => p.value,
				),
				() => "0",
			),
		)
	return part("hour") * 60 + part("minute")
}

/**
 * Which time columns get a label: the finest round clock step (5 min, 15 min, 1 h...) whose labels
 * do not collide at `plotWidth`, so ticks are evenly spaced. A label whose text would run past the
 * plot's right edge is dropped rather than clipped.
 */
export const timeTickColumns = (
	columns: ReadonlyArray<string>,
	plotWidth: number,
	labelOf: (iso: string) => string,
	timeZone: string | undefined,
): ReadonlySet<string> => {
	const times = Arr.map(columns, (iso) =>
		Option.match(DateTime.make(iso), { onNone: () => Number.NaN, onSome: DateTime.toEpochMillis }),
	)
	const [first, second] = times
	// Before the plot is measured there is no width to space labels by.
	if (!(plotWidth > 0)) return new Set()
	if (columns.length < 2 || first === undefined || second === undefined) return new Set(columns)
	const columnMin = (second - first) / 60_000
	const columnPx = plotWidth / columns.length
	const longest = Arr.reduce(columns, 0, (max, iso) => Math.max(max, labelOf(iso).length))
	const needPx = longest * TICK_CHAR_PX + TICK_GAP_PX
	const fitsRight = (index: number) =>
		(columns.length - index - 0.5) * columnPx >= (labelOf(columns[index] ?? "").length * TICK_CHAR_PX) / 2
	// Columns on a round local time: whole minutes (sub-minute columns share one), on the step.
	const onStep = (minutes: number) =>
		Arr.filter(columns, (_, index) => {
			const ms = times[index] ?? Number.NaN
			return ms % 60_000 === 0 && localMinuteOfDay(ms, timeZone) % minutes === 0 && fitsRight(index)
		})
	// The finest round step that fits and that columns land on (a +5:30 zone misses hourly ones).
	const stepped = Arr.findFirst(TICK_STEPS_MIN, (minutes) => {
		if (minutes < columnMin || (minutes / columnMin) * columnPx < needPx) return Option.none()
		const hits = onStep(minutes)
		return hits.length >= 2 ? Option.some(hits) : Option.none()
	})
	// Otherwise (odd widths, offset zones, multi-day windows): every k-th column from the first.
	const every = Math.max(1, Math.ceil(needPx / columnPx))
	const picked = Option.getOrElse(stepped, () =>
		Arr.filter(columns, (_, index) => index % every === 0 && fitsRight(index)),
	)
	return new Set(picked)
}

export const truncateYLabel = (label: string, maxChars: number): string =>
	label.length <= maxChars ? label : `${Str.slice(0, Math.max(1, maxChars - 1))(label)}…`
