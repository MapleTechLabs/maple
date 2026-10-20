import { formatNumber, formatPercent, formatValueByUnit } from "@maple/ui/lib/format"
import { muteColor } from "@maple/ui/components/plot/color-scale"
import { defineChart, type ChartFocusStrategy, type ChartPoint } from "@tanstack/charts"
import {
	focusGroupAngle,
	pie,
	polar,
	radialArc,
	radialText,
	type PieDatum,
	type PolarLayoutContext,
} from "@tanstack/charts/polar"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { tooltip } from "@tanstack/charts/tooltip"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec, type PieSliceRow } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip, MUTED_COLOR_AMOUNT } from "./plot-constants"

// Port of packages/ui/src/components/charts/pie/query-builder-pie-chart.tsx (definition half),
// plus the lab pie figure.

type PieSlice = PieDatum<PieSliceRow>
type PieSpec = Extract<ChartSpec, { readonly _tag: "Pie" }>
type PieSpikeSpec = Extract<ChartSpec, { readonly _tag: "PieSpike" }>

const LABEL_MIN_FRACTION = 0.06
const LABEL_RADIUS_DONUT = 0.5
const LABEL_RADIUS_PIE = 0.62
const HOVER_GROWTH = 1.035
const REST_OPACITY = 0.55
const PLOT_INSET = 8
const SLICE_STROKE_WIDTH = 1.5

const fmtValue = (value: number, unit: string | null): string =>
	unit ? formatValueByUnit(value, unit) : formatNumber(value)

/** The donut hole, in pixels; shared by the arc mark, the label scale and the centre total. */
export const resolveInnerRadius = (
	outerRadius: number,
	donut: boolean,
	innerRadius: number | null,
): number => {
	if (!donut) return 0
	return Math.max(8, Math.min(outerRadius - 6, innerRadius ?? outerRadius * 0.58))
}

/** The polar layout the arcs were struck from, recorded for `wedgeFocus`. */
interface PolarLayoutBox {
	layout: PolarLayoutContext | null
}

const pointerAngle = (dx: number, dy: number): number => {
	const angle = Math.atan2(dx, -dy)
	return angle < 0 ? angle + Math.PI * 2 : angle
}

/** Focus that engages only over a wedge: containment, not proximity. */
const wedgeFocus = (
	box: PolarLayoutBox,
	donut: boolean,
	innerRadius: number | null,
): ChartFocusStrategy<PieSlice, number, number> => {
	const wedgeAt = (points: readonly ChartPoint<PieSlice, number, number>[], x: number, y: number) => {
		const layout = box.layout
		if (layout === null) return undefined
		const dx = x - layout.centerX
		const dy = y - layout.centerY
		const distance = Math.hypot(dx, dy)
		if (distance < resolveInnerRadius(layout.radius, donut, innerRadius)) return undefined
		if (distance > layout.radius * HOVER_GROWTH) return undefined
		const angle = pointerAngle(dx, dy)
		return points.find((point) => point.datum.startAngle <= angle && angle < point.datum.endAngle)
	}

	return {
		resolve: (points, context) => {
			const point = wedgeAt(points, context.x, context.y)
			return point ? [point] : []
		},
		group: (_points, context) => [context.point],
		navigation: (points) => {
			const seen = new Set<string>()
			const unique: ChartPoint<PieSlice, number, number>[] = []
			for (const point of points) {
				if (seen.has(point.datum.name)) continue
				seen.add(point.datum.name)
				unique.push(point)
			}
			return unique.sort((left, right) => left.datum.startAngle - right.datum.startAngle)
		},
	}
}

const sliceTooltip = (
	points: ReadonlyArray<ChartPoint<PieSlice, number, number>>,
): Option.Option<ChartTooltip> =>
	Option.map(Option.fromNullishOr(points[0]?.datum), (slice) => {
		const { name, value, fraction, color, collapsedCount } = slice
		if (collapsedCount === undefined) return ChartTooltip.PieSlice({ name, value, fraction, color })
		return ChartTooltip.PieSlice({ name, value, fraction, color, collapsedCount })
	})

/** `QueryBuilderPieChart`'s `definition` memo. */
export const buildPie = (spec: PieSpec): BuiltChart<PieSlice, number, number> => {
	const { activeName, highlighted, donut, innerRadius, showLabels, showPercent, unit } = spec
	const slices = pie(spec.rows, { value: (row: PieSliceRow) => row.value })
	const active = activeName === null ? [] : slices.filter((slice) => slice.name === activeName)
	const rest = activeName === null ? slices : slices.filter((slice) => slice.name !== activeName)

	const fillFor = (slice: PieSlice) =>
		highlighted === null || slice.name === highlighted
			? slice.color
			: muteColor(slice.color, spec.background, MUTED_COLOR_AMOUNT)

	const layoutBox: PolarLayoutBox = { layout: null }
	const innerRadiusFor = (context: PolarLayoutContext) => {
		layoutBox.layout = context
		return resolveInnerRadius(context.radius, donut, innerRadius)
	}

	const arcOptions = {
		startAngle: (slice: PieSlice) => slice.startAngle,
		endAngle: (slice: PieSlice) => slice.endAngle,
		innerRadius: innerRadiusFor,
		fill: fillFor,
		stroke: spec.background,
		strokeWidth: SLICE_STROKE_WIDTH,
	}

	const arcs = [
		radialArc(rest, {
			...arcOptions,
			outerRadius: (context) => context.radius,
			fillOpacity: activeName === null ? undefined : REST_OPACITY,
		}),
		radialArc(active, { ...arcOptions, outerRadius: (context) => context.radius * HOVER_GROWTH }),
	] as const

	const labels = radialText(slices, {
		angle: (slice: PieSlice) => slice.angle,
		radius: (slice: PieSlice) =>
			slice.fraction < LABEL_MIN_FRACTION ? null : donut ? LABEL_RADIUS_DONUT : LABEL_RADIUS_PIE,
		text: (slice: PieSlice) =>
			showPercent ? formatPercent(slice.fraction) : fmtValue(slice.value, unit),
		fill: "#ffffff",
		fontSize: 11,
		fontWeight: 600,
	})

	const frame = { radiusRatio: 1, inset: PLOT_INSET } as const
	const wedges = showLabels
		? polar({
				...frame,
				scales: {
					angle: { scale: scaleLinear().domain([0, Math.PI * 2]) },
					radius: {
						scale: scaleLinear().domain([0, 1]),
						range: [innerRadiusFor, (context) => context.radius],
					},
				},
				marks: [...arcs, labels],
			})
		: polar({ ...frame, scales: { angle: null, radius: null }, marks: [...arcs] })

	return {
		definition: defineChart({
			marks: [wedges],
			scales: { x: null, y: null },
			focus: wedgeFocus(layoutBox, donut, innerRadius),
			focusRing: false,
			tooltip: spec.showTooltip ? cursorTooltip<PieSlice>("pointer") : false,
		}),
		focusKeyOf: (point) => point.datum.name,
		tooltipOf: sliceTooltip,
	}
}

/** `PieFigure`'s `definition` memo. Rows carry the colour `colorFor` resolved. */
export const buildPieSpike = (spec: PieSpikeSpec): BuiltChart<PieSlice, number, number> => {
	const { donut, activeName } = spec
	const slices = pie(spec.rows, { value: (row: PieSliceRow) => row.value, gapAngle: 0.012 })
	// NOTE: `activeName` is undefined when no legend wires it, so `=== null` is false and
	// every slice takes REST_OPACITY.
	const active = activeName === null ? [] : slices.filter((slice) => slice.name === activeName)
	const rest = activeName === null ? slices : slices.filter((slice) => slice.name !== activeName)

	const arcOptions = {
		startAngle: (slice: PieSlice) => slice.startAngle,
		endAngle: (slice: PieSlice) => slice.endAngle,
		innerRadius: (context: { radius: number }) => (donut ? Math.max(8, context.radius * 0.58) : 0),
		cornerRadius: 2,
	}

	return {
		definition: defineChart({
			marks: [
				polar({
					radiusRatio: 1,
					inset: 8,
					scales: { angle: null, radius: null },
					marks: [
						radialArc(rest, {
							...arcOptions,
							outerRadius: (context) => context.radius,
							fill: (slice) => slice.color,
							fillOpacity: activeName === null ? 1 : REST_OPACITY,
						}),
						radialArc(active, {
							...arcOptions,
							outerRadius: (context) => context.radius * HOVER_GROWTH,
							fill: (slice) => slice.color,
						}),
					],
				}),
			],
			scales: { x: null, y: null },
			focus: focusGroupAngle,
			focusRing: false,
			tooltip: { use: tooltip, className: "maple-plot-tooltip" },
		}),
		focusKeyOf: (point) => point.datum.name,
		tooltipOf: sliceTooltip,
	}
}
