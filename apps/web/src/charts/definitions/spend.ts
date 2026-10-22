import { formatCurrency } from "@maple/domain/format"
import { makeBucketAxis } from "@maple/ui/components/plot/bucket-axis"
import { focusCrosshair } from "@maple/ui/components/plot/plot-focus"
import { DASHED_Y_GRID } from "@maple/ui/components/plot/plot-grid"
import { formatDateInTimezone } from "@maple/web-data/lib/timezone-format"
import { areaY, d3Curve, defineChart, dot, lineY, ruleX, stack } from "@tanstack/charts"
import { decorative } from "@tanstack/charts/mark/decorative"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"
import { Option } from "effect"
import { ChartTooltip, type ChartSpec } from "../chart-spec"
import type { BuiltChart } from "./built-chart"
import { cursorTooltip } from "./plot-constants"

// The spend chart's definition.

type SpendSpec = Extract<ChartSpec, { readonly _tag: "SpendCumulative" }>
type Point = SpendSpec["points"][number]

/** One stacked band segment: a day, its band, and its dollars (`stack()` groups on `z`). */
interface SpendCell {
	readonly point: Point
	readonly band: string
	readonly value: number | null
}

/** A band segment when the stack is hovered, or a bare day from the projection line. */
type SpendDatum = Point | SpendCell

const dayOf = (datum: SpendDatum): Point => ("point" in datum ? datum.point : datum)

/** Spend days are UTC calendar days: label them on that clock whatever the viewer's zone. */
const SPEND_TIME_ZONE = "UTC"

const dateLabel = (value: string) =>
	formatDateInTimezone(new Date(`${value}T00:00:00Z`), { timeZone: SPEND_TIME_ZONE, withYear: false })

export const buildSpendCumulative = (spec: SpendSpec): BuiltChart<SpendDatum, Date, number> => {
	const points = spec.points
	const at = (point: Point) => new Date(point.dayMs)
	const keys = spec.bands.map((band) => band.key)
	const colorOf = (key: string) => spec.bands.find((band) => band.key === key)?.color ?? spec.chrome.border
	const todayPoint = points.findLast((point) => !point.future)
	const lastPoint = points[points.length - 1]
	const hasFuture = lastPoint !== undefined && lastPoint.future
	const axis = makeBucketAxis(
		points.map((point) => point.date),
		SPEND_TIME_ZONE,
	)
	const cells: ReadonlyArray<SpendCell> = points.flatMap((point) =>
		keys.map((band) => ({ point, band, value: point.bands[band] ?? null })),
	)
	// The series anchors the projection at today and the cycle's end only; every day between gets its
	// point on that straight line so hovering a day to come reads its projected total.
	const projectionOf = (point: Point): number | null => {
		if (
			!hasFuture ||
			todayPoint === undefined ||
			lastPoint === undefined ||
			point.dayMs < todayPoint.dayMs
		)
			return null
		const start = todayPoint.projected ?? 0
		const span = lastPoint.dayMs - todayPoint.dayMs
		return span <= 0
			? spec.projected
			: start + ((spec.projected - start) * (point.dayMs - todayPoint.dayMs)) / span
	}
	const projectedPoints = points.filter((point) => projectionOf(point) !== null)

	const definition = defineChart({
		marks: [
			areaY(cells, {
				x: (cell: SpendCell) => at(cell.point),
				y: (cell: SpendCell) => cell.value,
				z: (cell: SpendCell) => cell.band,
				fill: (cell: SpendCell) => colorOf(cell.band),
				fillOpacity: 0.35,
				stroke: (cell: SpendCell) => colorOf(cell.band),
				strokeWidth: 1,
				curve: d3Curve(curveMonotoneX),
				layout: stack({ order: [...keys] }),
			}),
			// The projection: today's actual total joined to where the cycle lands, dashed.
			...(hasFuture
				? [
						lineY(projectedPoints, {
							id: "projected",
							x: at,
							y: projectionOf,
							stroke: spec.primary,
							strokeWidth: 1.5,
							strokeDasharray: "4 4",
						}),
					]
				: []),
			...(hasFuture && lastPoint !== undefined
				? [decorative(dot([lastPoint], { x: at, y: () => spec.projected, r: 3, fill: spec.primary }))]
				: []),
			// "Today": a vertical rule.
			...(todayPoint === undefined
				? []
				: [
						decorative(
							ruleX([todayPoint], {
								x: at,
								stroke: spec.chrome.border,
								strokeOpacity: 1,
								strokeWidth: 1,
							}),
						),
					]),
			focusCrosshair(spec.chrome),
		],
		scales: {
			x: axis.x,
			y: {
				grid: DASHED_Y_GRID,
				scale: scaleLinear().domain([0, spec.yMax]),
				axis: {
					line: false,
					ticks: { size: 0, padding: 8, format: (value: number) => `$${Math.round(value)}` },
				},
			},
		},
		margin: { top: 8, right: 56, left: 52 },
		focus: "group-x",
		focusRing: false,
		tooltip: cursorTooltip<SpendDatum>("pointer"),
	})

	return {
		definition,
		focusKeyOf: (point) => dayOf(point.datum).date,
		tooltipOf: (focused) =>
			Option.map(Option.fromNullishOr(focused[0]?.datum), (datum) => {
				const day = dayOf(datum)
				const money = (value: number) => formatCurrency(value, spec.currency)
				const actual = spec.bands.flatMap((band) => {
					const value = day.bands[band.key]
					return value === null || value === undefined || (value === 0 && band.key !== "base")
						? []
						: [{ label: band.label, color: band.color, dashed: false, value: money(value) }]
				})
				const spent =
					actual.length === 0
						? null
						: spec.bands.reduce((sum, band) => sum + (day.bands[band.key] ?? 0), 0)
				const projection = day.future ? projectionOf(day) : null
				return ChartTooltip.Bucket({
					heading: day.future ? `${dateLabel(day.date)} · projected` : dateLabel(day.date),
					rows: [
						...actual,
						...(projection === null
							? []
							: [
									{
										label: "Projected",
										color: spec.primary,
										dashed: true,
										value: money(projection),
									},
								]),
					],
					...(spent !== null && actual.length > 1 && { total: money(spent) }),
				})
			}),
	}
}
