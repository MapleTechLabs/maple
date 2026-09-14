import { memo, useId } from "react"
import { ChartSkeleton } from "@maple/ui/components/charts/_shared/chart-skeleton"
import { formatValueByUnit } from "@maple/ui/lib/format"
import { WidgetFrame } from "@/components/dashboard-builder/widgets/widget-shell"
import type { WidgetDataState, WidgetDisplayConfig, WidgetMode } from "@/components/dashboard-builder/types"

interface GaugeWidgetProps {
	dataState: WidgetDataState
	display: WidgetDisplayConfig
	mode: WidgetMode
}

// Geometry for a 270° segmented gauge. The viewBox is fitted to the drawn
// content per render (see `bounds` below), so these are dial-local units.
const CX = 120
const CY = 118
const R_OUTER = 88
const R_INNER = 58
const R_RIM = 93
const R_LABEL = 104
const R_TICK_INNER = 89
const R_TICK_OUTER = 96
const START_ANGLE = 135
const SWEEP = 270
const END_ANGLE = START_ANGLE + SWEEP
const SEGMENT_COUNT = 56
const RIM_SEGMENT_COUNT = 96
const GAP_RATIO = 0.32
const VALUE_Y = 108
const VALUE_FONT_SIZE = 28
const LABEL_FONT_SIZE = 9
// Geist Mono: every glyph is 0.6em wide, so text extents are exact, not guessed.
const MONO_ADVANCE = 0.6
// Widest a value may render before it shrinks: the hole is 2·R_INNER across and
// the value should not touch the blades.
const VALUE_MAX_WIDTH = R_INNER * 2 - 12
// The range bounds sit in the bottom opening, just under the blade ends.
const BOUND_LABEL_DROP = 14
const BOX_PAD = 3
/**
 * Minimum arc separation between two rim *labels*, in degrees.
 *
 * Labels are horizontal and centred on their tick, so the binding case is two
 * of them side by side: at R_LABEL a 9px-font value like "100%" is ~22px wide,
 * which is ~12° of arc. Anything closer overlaps.
 *
 * Thresholds bunched against a bound (0/95/99/100 on a 0–100 gauge — the whole
 * top 5% of the range lands within 13° of the max) therefore keep their tick and
 * drop their text, rather than stacking three unreadable numbers on each other.
 */
const MIN_LABEL_GAP_DEG = 16

// Perceptual green → yellow → orange → red ramp swept along the arc.
const RAMP: ReadonlyArray<readonly [number, number, number, number]> = [
	[0, 86, 199, 88],
	[0.5, 232, 205, 58],
	[0.74, 242, 142, 44],
	[1, 233, 64, 56],
]

function rampColor(fraction: number): string {
	const x = fraction < 0 ? 0 : fraction > 1 ? 1 : fraction
	let lo = RAMP[0]
	let hi = RAMP[RAMP.length - 1]
	for (let i = 0; i < RAMP.length - 1; i++) {
		if (x >= RAMP[i][0] && x <= RAMP[i + 1][0]) {
			lo = RAMP[i]
			hi = RAMP[i + 1]
			break
		}
	}
	const t = (x - lo[0]) / (hi[0] - lo[0] || 1)
	const channel = (index: number) => Math.round(lo[index] + (hi[index] - lo[index]) * t)
	return `rgb(${channel(1)}, ${channel(2)}, ${channel(3)})`
}

function polar(radius: number, degrees: number): { x: number; y: number } {
	const radians = (degrees * Math.PI) / 180
	return { x: CX + radius * Math.cos(radians), y: CY + radius * Math.sin(radians) }
}

// A four-point fan blade between two radii across an angular slice.
function bladePoints(startDeg: number, endDeg: number): string {
	const a = polar(R_INNER, startDeg)
	const b = polar(R_OUTER, startDeg)
	const c = polar(R_OUTER, endDeg)
	const d = polar(R_INNER, endDeg)
	return `${a.x},${a.y} ${b.x},${b.y} ${c.x},${c.y} ${d.x},${d.y}`
}

function toNumber(value: unknown): number | null {
	if (value === null || value === undefined || typeof value === "object") return null
	const num = typeof value === "number" ? value : Number(value)
	return Number.isFinite(num) ? num : null
}

// Scale labels drop the forced decimal ("100.0%" → "100%", "420.0ms" → "420ms"):
// they mark positions, and the precision belongs to the value in the centre.
function scaleLabel(value: number, unit: string | undefined): string {
	return formatValueByUnit(value, unit).replace(/\.0(?=\D*$)/, "")
}

const textWidth = (text: string, fontSize: number) => text.length * fontSize * MONO_ADVANCE

export const GaugeWidget = memo(function GaugeWidget({ dataState, display, mode }: GaugeWidgetProps) {
	const glowId = useId().replace(/:/g, "")
	const rawValue = dataState.status === "ready" ? dataState.data : undefined
	const value = toNumber(rawValue)

	const min = display.gauge?.min ?? 0
	const max = display.gauge?.max ?? 100
	const span = max - min > 0 ? max - min : 1
	const fraction = value !== null ? Math.min(1, Math.max(0, (value - min) / span)) : 0

	const formattedValue =
		value !== null
			? `${display.prefix ?? ""}${formatValueByUnit(value, display.unit)}${display.suffix ?? ""}`
			: "—"
	// "1,240.5ms" at full size is wider than the hole; scale the font down rather
	// than let the value run into the blades.
	const valueFontSize = Math.min(VALUE_FONT_SIZE, VALUE_MAX_WIDTH / (formattedValue.length * MONO_ADVANCE))

	const slotAngle = SWEEP / SEGMENT_COUNT
	const gapAngle = slotAngle * GAP_RATIO
	const segments = Array.from({ length: SEGMENT_COUNT }, (_, index) => {
		const slotStart = START_ANGLE + index * slotAngle
		const mid = (index + 0.5) / SEGMENT_COUNT
		const filled = value !== null && mid <= fraction
		return {
			points: bladePoints(slotStart + gapAngle / 2, slotStart + slotAngle - gapAngle / 2),
			filled,
			color: rampColor(mid),
		}
	})

	// Continuous gradient scale line traced just outside the blades.
	const rim = Array.from({ length: RIM_SEGMENT_COUNT }, (_, index) => {
		const from = index / RIM_SEGMENT_COUNT
		const to = (index + 1) / RIM_SEGMENT_COUNT
		return {
			a: polar(R_RIM, START_ANGLE + from * SWEEP),
			b: polar(R_RIM, START_ANGLE + to * SWEEP),
			color: rampColor((from + to) / 2),
		}
	})

	// Rim ticks: every in-range bound and threshold gets one, so a threshold whose
	// text can't fit still reads as a marked position on the arc.
	const seen = new Set<number>()
	const angleFor = (tickValue: number) => START_ANGLE + ((tickValue - min) / span) * SWEEP
	const ticks = [min, max, ...(display.thresholds ?? []).map((threshold) => threshold.value)]
		// Bounds first so that when a threshold crowds one of them it is the
		// threshold that loses its label — the range endpoints anchor the scale.
		.filter((tickValue) => {
			if (tickValue < min || tickValue > max || seen.has(tickValue)) return false
			seen.add(tickValue)
			return true
		})
		.map((tickValue) => ({ value: tickValue, angle: angleFor(tickValue) }))

	// The bounds label the two blade ends from inside the bottom opening, where
	// the dial has room to spare. Outside the rim they were the widest and lowest
	// points of the drawing, and cost every gauge a margin it used for nothing.
	const boundLabels = [min, max].map((boundValue, index) => {
		const end = polar((R_INNER + R_OUTER) / 2, index === 0 ? START_ANGLE : END_ANGLE)
		return {
			value: boundValue,
			text: scaleLabel(boundValue, display.unit),
			x: end.x,
			y: end.y + BOUND_LABEL_DROP,
		}
	})

	// Threshold labels sit outside the rim, horizontal and centred on their tick.
	// Only those that clear MIN_LABEL_GAP_DEG from the bounds and from every
	// already-placed label get text.
	const placedAngles = [START_ANGLE, END_ANGLE]
	const labels = ticks
		.filter((tick) => {
			if (tick.value === min || tick.value === max) return false
			if (placedAngles.some((angle) => Math.abs(angle - tick.angle) < MIN_LABEL_GAP_DEG)) {
				return false
			}
			placedAngles.push(tick.angle)
			return true
		})
		.map((tick) => {
			const point = polar(R_LABEL, tick.angle)
			return { value: tick.value, text: scaleLabel(tick.value, display.unit), x: point.x, y: point.y }
		})

	// Fit the viewBox to what is drawn, so the dial takes the whole tile rather
	// than a fixed box padded for the widest label any gauge might ever show. The
	// width is reserved for the widest label at the rim's horizontal extreme
	// regardless of where the label actually sits, so moving a threshold does
	// not resize the dial — only the unit's label width does.
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
	const bottom = boundLabels[0].y + LABEL_FONT_SIZE * 0.7
	const box = {
		x: CX - halfWidth - BOX_PAD,
		y: top - BOX_PAD,
		width: halfWidth * 2 + BOX_PAD * 2,
		height: bottom - top + BOX_PAD * 2,
	}

	return (
		<WidgetFrame
			title={display.title || "Untitled"}
			dataState={dataState}
			mode={mode}
			contentClassName="flex-1 min-h-0 flex items-center justify-center p-1 @min-[200px]/widget:p-2"
			loadingSkeleton={<ChartSkeleton variant="gauge" />}
		>
			<svg
				viewBox={`${box.x} ${box.y} ${box.width} ${box.height}`}
				preserveAspectRatio="xMidYMid meet"
				className="h-full w-full"
				role="img"
				aria-label={`Gauge: ${formattedValue}`}
			>
				<defs>
					<filter id={`glow-${glowId}`} x="-40%" y="-40%" width="180%" height="180%">
						<feGaussianBlur stdDeviation="3" />
					</filter>
					<radialGradient id={`hole-${glowId}`} cx="0.5" cy="0.46" r="0.6">
						<stop offset="0%" stopColor="var(--muted)" stopOpacity={0.55} />
						<stop offset="100%" stopColor="var(--muted)" stopOpacity={0} />
					</radialGradient>
				</defs>

				{/* Subtle depth in the dial face. */}
				<circle cx={CX} cy={CY} r={R_INNER - 2} fill={`url(#hole-${glowId})`} />

				{/* Bloom underlay for the lit blades. */}
				<g filter={`url(#glow-${glowId})`} opacity={0.7}>
					{segments.map((segment, index) =>
						segment.filled ? (
							<polygon key={index} points={segment.points} fill={segment.color} />
						) : null,
					)}
				</g>

				{/* Fan blades — lit blades carry the color ramp, the rest are dimmed. */}
				{segments.map((segment, index) => (
					<polygon
						key={index}
						points={segment.points}
						fill={segment.filled ? segment.color : "var(--muted-foreground)"}
						fillOpacity={segment.filled ? 1 : 0.22}
					/>
				))}

				{/* Continuous gradient scale line on the outer layer. */}
				{rim.map((segment, index) => (
					<line
						key={`rim-${index}`}
						x1={segment.a.x}
						y1={segment.a.y}
						x2={segment.b.x}
						y2={segment.b.y}
						stroke={segment.color}
						strokeWidth={1.7}
						strokeLinecap="round"
					/>
				))}

				{/* Range + threshold ticks across the rim. */}
				{ticks.map((tick) => {
					const inner = polar(R_TICK_INNER, tick.angle)
					const outer = polar(R_TICK_OUTER, tick.angle)
					return (
						<line
							key={`tick-${tick.value}`}
							x1={inner.x}
							y1={inner.y}
							x2={outer.x}
							y2={outer.y}
							stroke="var(--muted-foreground)"
							strokeOpacity={0.55}
							strokeWidth={1.4}
							strokeLinecap="round"
						/>
					)
				})}

				{/* Range bounds under the blade ends, threshold labels outside the rim. */}
				{[...boundLabels, ...labels].map((label) => (
					<text
						key={label.value}
						x={label.x}
						y={label.y}
						textAnchor="middle"
						dominantBaseline="central"
						className="fill-muted-foreground"
						style={{ fontSize: LABEL_FONT_SIZE }}
					>
						{label.text}
					</text>
				))}

				{/* Center value. */}
				<text
					x={CX}
					y={VALUE_Y}
					textAnchor="middle"
					dominantBaseline="central"
					className="fill-foreground"
					style={{ fontSize: valueFontSize, fontWeight: 700, letterSpacing: "-0.02em" }}
				>
					{formattedValue}
				</text>
			</svg>
		</WidgetFrame>
	)
})
