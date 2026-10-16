import { useMemo, type ReactNode } from "react"
import { areaY, d3Curve, defineChart, stack } from "@tanstack/charts"
import { scaleLinear } from "@tanstack/charts-scales/linear"
import { curveMonotoneX } from "d3-shape"

import {
	CursorPlot,
	DASHED_Y_GRID,
	focusCrosshair,
	linearYDomain,
	makeBucketAxis,
	niceLinearDomain,
	useChartId,
	useCursorPlot,
	verticalGradient,
	type CursorPlotSeries,
} from "@maple/ui/components/plot"
import { OTHER_COLOR } from "@maple/ui/components/charts"
import { linkedCursorChartProps } from "@/hooks/use-linked-cursor"
import { useTimezonePreference } from "@/hooks/use-timezone-preference"

import { formatNumber } from "@maple/ui/lib/format"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import { transformRows } from "../chart-utils"
import {
	CHART_EMPTY_MESSAGE,
	CHART_HEIGHT,
	ChartCard,
	ChartCardMessage,
} from "@/components/common/chart-card"
import { SeriesLegend } from "@/components/common/series-legend"
import { BREAKDOWN_OTHER_KEY, BREAKDOWN_OTHER_LABEL } from "./constants"

/**
 * Series ceiling for a dimension with no fixed vocabulary. The API already folds the tail into
 * `BREAKDOWN_OTHER_KEY`, so this only catches a response that predates that fold (a cached one, or
 * a caller that passes rows straight through) — without it, one stale payload puts thousands of
 * `<Area>` elements back on the page.
 */
const MAX_SERIES = 6

/** Legend chips beyond this collapse into a `+N`, so the legend can never reflow the card header. */
const MAX_LEGEND_CHIPS = 8

/** The pooled-tail sentinel is a wire value, never a label. */
const seriesLabel = (name: string) => (name === BREAKDOWN_OTHER_KEY ? BREAKDOWN_OTHER_LABEL : name)

export interface StackedBreakdownChartProps {
	title: string
	rows: ReadonlyArray<{ bucket: string; attributeValue: string; value: number }>
	colors: Record<string, string>
	/** Fixed legend/stack order; unlisted series append after, alphabetically. */
	order: ReadonlyArray<string>
	syncId?: string
	scope?: ReactNode
}

/**
 * Cap the series count for dimensions with no fixed vocabulary, pooling the rest into one `Other`.
 * Dimensions that pass an `order` (status class, cache status) have a small closed vocabulary and
 * are left alone — folding those would hide a status class the operator is looking for.
 */
function foldTail(rows: StackedBreakdownChartProps["rows"]): StackedBreakdownChartProps["rows"] {
	const totals = new Map<string, number>()
	for (const row of rows) {
		totals.set(row.attributeValue, (totals.get(row.attributeValue) ?? 0) + row.value)
	}
	if (totals.size <= MAX_SERIES + 1) return rows
	const keep = new Set(
		[...totals.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, MAX_SERIES)
			.map(([name]) => name),
	)
	// Re-sum per bucket so the pooled series is one point per bucket, not N overlapping ones.
	const pooled = new Map<string, number>()
	const kept: Array<{ bucket: string; attributeValue: string; value: number }> = []
	for (const row of rows) {
		if (keep.has(row.attributeValue)) kept.push(row)
		else pooled.set(row.bucket, (pooled.get(row.bucket) ?? 0) + row.value)
	}
	for (const [bucket, value] of pooled) {
		kept.push({ bucket, attributeValue: BREAKDOWN_OTHER_KEY, value })
	}
	return kept
}

/** One band segment: a bucket row, the series it belongs to, and its value. */
interface BreakdownCell {
	row: Record<string, unknown>
	bucket: string
	date: Date
	name: string
	value: number
}

/**
 * A key absent from a bucket row is a zero count (the API only writes keys it
 * saw), and `stack()` starts a new segment at a null — so the band would tear
 * wherever one status class went quiet for a bucket.
 */
const cellValue = (value: unknown): number => (typeof value === "number" ? value : 0)

export function StackedBreakdownChart({
	title,
	rows,
	colors,
	order,
	syncId,
	scope,
}: StackedBreakdownChartProps) {
	const gradientPrefix = useChartId("breakdown")
	const { data, series } = useMemo(() => {
		const bounded = order.length > 0 ? rows : foldTail(rows)
		const transformed = transformRows(bounded)
		const rank = new Map(order.map((name, idx) => [name, idx]))
		// The pooled tail always sorts last — it is the leftovers, not a peer of the named series.
		const rankOf = (name: string) =>
			name === BREAKDOWN_OTHER_KEY ? Number.MAX_SAFE_INTEGER : (rank.get(name) ?? order.length)
		const sorted = [...transformed.series].sort((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
		return { data: transformed.data, series: sorted }
	}, [rows, order])

	// Fixed vocabularies (status class, cache status) map a color to a meaning. Everything else
	// hashes its name into the shared identity palette, so a path/country/host keeps its color
	// across windows and stays distinguishable instead of collapsing into one fallback hue.
	const paletteByName = useMemo(() => {
		const identities = series.filter((name) => colors[name] == null && name !== BREAKDOWN_OTHER_KEY)
		const identityColors = resolveSeriesColors(identities)
		const map = new Map<string, string>()
		for (const name of series) {
			map.set(
				name,
				colors[name] ??
					(name === BREAKDOWN_OTHER_KEY ? OTHER_COLOR : (identityColors.get(name) ?? OTHER_COLOR)),
			)
		}
		return map
	}, [series, colors])

	const cursorSeries = useMemo<CursorPlotSeries<BreakdownCell>[]>(
		() =>
			series.map((name) => ({
				key: name,
				label: seriesLabel(name),
				color: paletteByName.get(name) ?? OTHER_COLOR,
				// Off the bucket ROW, so hovering one band still prints every series.
				value: (cell: BreakdownCell) => {
					const value = cell.row[name]
					return typeof value === "number" ? value : null
				},
				format: (value: number) => formatNumber(value),
			})),
		[series, paletteByName],
	)
	const plot = useCursorPlot(cursorSeries)
	const colorOf = plot.color

	// A time axis over the buckets' instants — see `makeBucketAxis` for why the
	// label point scale this replaced folded a 24h window onto itself.
	const { effectiveTimezone } = useTimezonePreference()
	const axis = useMemo(
		() =>
			makeBucketAxis(
				data.map((point) => point.bucket),
				effectiveTimezone,
			),
		[data, effectiveTimezone],
	)

	const yDomain = useMemo<[number, number]>(
		() => niceLinearDomain(linearYDomain({ rows: data, keys: series, stacked: true })),
		[data, series],
	)

	const definition = useMemo(() => {
		const cells: BreakdownCell[] = data.flatMap((row) =>
			series.map((name) => ({
				row,
				bucket: row.bucket,
				date: row.date,
				name,
				value: cellValue(row[name]),
			})),
		)

		return defineChart({
			gradients: series.map((name) =>
				verticalGradient(`${gradientPrefix}-${name.replace(/\W+/g, "_")}`, colorOf(name), 0.4, 0.05),
			),
			marks: [
				areaY(cells, {
					x: (cell: BreakdownCell) => cell.date,
					y: (cell: BreakdownCell) => cell.value,
					z: (cell: BreakdownCell) => cell.name,
					fill: (cell: BreakdownCell) =>
						`url(#${gradientPrefix}-${cell.name.replace(/\W+/g, "_")})`,
					stroke: (cell: BreakdownCell) => colorOf(cell.name),
					strokeWidth: 1.25,
					curve: d3Curve(curveMonotoneX),
					layout: stack({ order: [...series] }),
				}),
				focusCrosshair(plot.chrome),
			],
			scales: {
				x: axis.x,
				y: {
					grid: DASHED_Y_GRID,
					scale: scaleLinear().domain(yDomain),
					axis: {
						line: false,
						ticks: { size: 0, padding: 8, format: (v: number) => formatNumber(v) },
					},
				},
			},
			// `bottom` unset on purpose: a set side is a hard lock, and only a measured
			// side reserves the x tick labels' height.
			margin: { top: 12, right: 12, left: 60 },
			focus: "group-x",
			focusRing: false,
			tooltip: plot.tooltip,
		})
	}, [data, series, axis, plot, colorOf, gradientPrefix, yDomain])

	return (
		<ChartCard
			title={title}
			scope={scope}
			legend={
				<SeriesLegend
					maxItems={MAX_LEGEND_CHIPS}
					items={series.map((name) => ({
						key: name,
						label: seriesLabel(name),
						title: seriesLabel(name),
						color: paletteByName.get(name) ?? OTHER_COLOR,
					}))}
				/>
			}
		>
			{data.length === 0 ? (
				<ChartCardMessage>{CHART_EMPTY_MESSAGE}</ChartCardMessage>
			) : (
				<div
					className="w-full"
					style={{ height: CHART_HEIGHT }}
					{...linkedCursorChartProps(syncId != null ? `cf-breakdown-${title}` : undefined)}
				>
					<CursorPlot
						plot={plot}
						definition={definition}
						series={cursorSeries}
						heading={(cell: BreakdownCell) => axis.heading(cell.bucket)}
						ariaLabel={title}
						className="h-full w-full"
					/>
				</div>
			)}
		</ChartCard>
	)
}
