import { EMPTY_VALUE, formatValueByUnit } from "@maple/ui/lib/format"

// The gauge widget's geometry: a 270 degree segmented
// dial whose viewBox is fitted to what is drawn. The view is in ./tiles-gauge.ts.

const CX = 120
const CY = 118
const R_OUTER = 88
const R_INNER = 58
const R_RIM = 93
const R_LABEL = 104
export const R_TICK_INNER = 89
export const R_TICK_OUTER = 96
const START_ANGLE = 135
const SWEEP = 270
const END_ANGLE = START_ANGLE + SWEEP
const SEGMENT_COUNT = 56
const RIM_SEGMENT_COUNT = 96
const GAP_RATIO = 0.32
export const VALUE_Y = 108
const VALUE_FONT_SIZE = 28
export const LABEL_FONT_SIZE = 9
const MONO_ADVANCE = 0.6
const VALUE_MAX_WIDTH = R_INNER * 2 - 12
const BOUND_LABEL_DROP = 14
const BOX_PAD = 3
const MIN_LABEL_GAP_DEG = 16
export const GAUGE_CENTER = { x: CX, y: CY, holeRadius: R_INNER - 2 }

const RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
	[0, 86, 199, 88],
	[0.5, 232, 205, 58],
	[0.74, 242, 142, 44],
	[1, 233, 64, 56],
]

const rampColor = (fraction: number): string => {
	const x = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
	const index = RAMP.findIndex((stop, i) => i < RAMP.length - 1 && x >= stop[0] && x <= (RAMP[i + 1]?.[0] ?? 1))
	const lo = RAMP[index === -1 ? 0 : index] ?? [0, 0, 0, 0]
	const hi = RAMP[index === -1 ? RAMP.length - 1 : index + 1] ?? lo
	const t = (x - lo[0]) / (hi[0] - lo[0] || 1)
	const channel = (i: 1 | 2 | 3) => Math.round(lo[i] + (hi[i] - lo[i]) * t)
	return `rgb(${channel(1)}, ${channel(2)}, ${channel(3)})`
}

export const polar = (radius: number, degrees: number): { x: number; y: number } => {
	const radians = (degrees * Math.PI) / 180
	return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) }
}

const bladePoints = (startDeg: number, endDeg: number): string => {
	const a = polar(R_INNER, startDeg)
	const b = polar(R_OUTER, startDeg)
	const c = polar(R_OUTER, endDeg)
	const d = polar(R_INNER, endDeg)
	return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`
}

const toNumber = (value: unknown): number | null => {
	if (value === null || value === undefined || typeof value === "object") return null
	const num = typeof value === "number" ? value : Number(value)
	return Number.isFinite(num) ? num : null
}

const scaleLabel = (value: number, unit: string | undefined): string =>
	formatValueByUnit(value, unit).replace(/\.0(?=\D*$)/, "")

const textWidth = (text: string, fontSize: number) => text.length * fontSize * MONO_ADVANCE

type Threshold = Readonly<{ value: number }>

export type GaugeLabel = Readonly<{ value: number; text: string; x: number; y: number }>

export type GaugeOptions = Readonly<{
	min?: number | undefined
	max?: number | undefined
	unit?: string | undefined
	prefix?: string | undefined
	suffix?: string | undefined
	thresholds?: ReadonlyArray<Threshold> | undefined
}>

/** The blades and the rim line, lit up to the value's fraction of the range. */
const arcs = (value: number | null, fraction: number) => {
	const slotAngle = SWEEP / SEGMENT_COUNT
	const gapAngle = slotAngle * GAP_RATIO
	const segments = Array.from({ length: SEGMENT_COUNT }, (_, index) => {
		const slotStart = START_ANGLE + index * slotAngle
		const mid = (index + 0.5) / SEGMENT_COUNT
		return {
			points: bladePoints(slotStart + gapAngle / 2, slotStart + slotAngle - gapAngle / 2),
			filled: value !== null && mid <= fraction,
			color: rampColor(mid),
		}
	})
	const rim = Array.from({ length: RIM_SEGMENT_COUNT }, (_, index) => {
		const from = index / RIM_SEGMENT_COUNT
		const to = (index + 1) / RIM_SEGMENT_COUNT
		return {
			a: polar(R_RIM, START_ANGLE + from * SWEEP),
			b: polar(R_RIM, START_ANGLE + to * SWEEP),
			color: rampColor((from + to) / 2),
		}
	})
	return { segments, rim }
}

/** Ticks for the bounds and every in-range threshold; labels only where they clear their neighbours. */
const scale = (min: number, max: number, span: number, options: GaugeOptions) => {
	const angleFor = (tickValue: number) => START_ANGLE + ((tickValue - min) / span) * SWEEP
	const ticks = [min, max, ...(options.thresholds ?? []).map((threshold) => threshold.value)]
		.filter(
			(tickValue, index, all) => tickValue >= min && tickValue <= max && all.indexOf(tickValue) === index,
		)
		.map((tickValue) => ({ value: tickValue, angle: angleFor(tickValue) }))
	const boundLabels: ReadonlyArray<GaugeLabel> = [min, max].map((boundValue, index) => {
		const end = polar((R_INNER + R_OUTER) / 2, index === 0 ? START_ANGLE : END_ANGLE)
		return {
			value: boundValue,
			text: scaleLabel(boundValue, options.unit),
			x: end.x,
			y: end.y + BOUND_LABEL_DROP,
		}
	})
	const labels = ticks
		.filter((tick) => tick.value !== min && tick.value !== max)
		.reduce<ReadonlyArray<{ value: number; angle: number }>>(
			(placed, tick) =>
				[START_ANGLE, END_ANGLE, ...placed.map((p) => p.angle)].some(
					(angle) => Math.abs(angle - tick.angle) < MIN_LABEL_GAP_DEG,
				)
					? placed
					: [...placed, tick],
			[],
		)
		.map((tick): GaugeLabel => {
			const point = polar(R_LABEL, tick.angle)
			return { value: tick.value, text: scaleLabel(tick.value, options.unit), x: point.x, y: point.y }
		})
	return { ticks, boundLabels, labels }
}

/** Everything the dial draws, as the component computes it per render. */
export const gaugeGeometry = (rawValue: unknown, options: GaugeOptions) => {
	const value = toNumber(rawValue)
	const min = options.min ?? 0
	const max = options.max ?? 100
	const span = max - min > 0 ? max - min : 1
	const fraction = value !== null ? Math.min(1, Math.max(0, (value - min) / span)) : 0
	const formattedValue =
		value !== null
			? `${options.prefix ?? ""}${formatValueByUnit(value, options.unit)}${options.suffix ?? ""}`
			: EMPTY_VALUE
	const valueFontSize = Math.min(
		VALUE_FONT_SIZE,
		VALUE_MAX_WIDTH / (formattedValue.length * MONO_ADVANCE),
	)
	const { segments, rim } = arcs(value, fraction)
	const { ticks, boundLabels, labels } = scale(min, max, span, options)
	const widestLabel = labels.reduce(
		(width, label) => Math.max(width, textWidth(label.text, LABEL_FONT_SIZE)),
		0,
	)
	const halfWidth = Math.max(
		R_TICK_OUTER,
		labels.length > 0 ? R_LABEL + widestLabel / 2 : 0,
		textWidth(formattedValue, valueFontSize) / 2,
	)
	const top = Math.min(CY - R_TICK_OUTER, labels.length > 0 ? CY - R_LABEL - LABEL_FONT_SIZE * 0.7 : CY)
	const bottom = (boundLabels[0]?.y ?? 0) + LABEL_FONT_SIZE * 0.7
	const box = {
		x: CX - halfWidth - BOX_PAD,
		y: top - BOX_PAD,
		width: halfWidth * 2 + BOX_PAD * 2,
		height: bottom - top + BOX_PAD * 2,
	}
	return { formattedValue, valueFontSize, segments, rim, ticks, labels: [...boundLabels, ...labels], box }
}
