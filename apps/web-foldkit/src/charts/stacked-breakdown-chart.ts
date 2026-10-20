import { BREAKDOWN_OTHER_KEY, BREAKDOWN_OTHER_LABEL } from "../components/infra/cloudflare/constants"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import type { ChartSpec } from "./chart-spec"
import { type LongRow, transformRows } from "./infra-metric-series"
import { resolveColor, type ThemeColors } from "./theme-colors"

// `StackedBreakdownChart`'s data side: the tail fold, the stack order and the palette, resolved for
// the canvas. The card and legend are the page's.

export type StackedBreakdownSpec = Extract<ChartSpec, { readonly _tag: "StackedBreakdown" }>

/** `OTHER_COLOR` (packages/ui/src/components/charts/_shared/bucket-series.ts). */
const OTHER_COLOR = "var(--muted-foreground)"
/** Series ceiling for a dimension with no fixed vocabulary. */
const MAX_SERIES = 6

/** The pooled-tail sentinel is a wire value, never a label. */
export const breakdownSeriesLabel = (name: string) =>
	name === BREAKDOWN_OTHER_KEY ? BREAKDOWN_OTHER_LABEL : name

/** `foldTail`: cap an open vocabulary at `MAX_SERIES`, pooling the rest into one `other` per bucket. */
const foldTail = (rows: ReadonlyArray<LongRow>): ReadonlyArray<LongRow> => {
	const totals = rows.reduce(
		(acc, row) => acc.set(row.attributeValue, (acc.get(row.attributeValue) ?? 0) + row.value),
		new Map<string, number>(),
	)
	if (totals.size <= MAX_SERIES + 1) return rows
	const keep = new Set(
		[...totals.entries()]
			.toSorted((a, b) => b[1] - a[1])
			.slice(0, MAX_SERIES)
			.map(([name]) => name),
	)
	const pooled = rows
		.filter((row) => !keep.has(row.attributeValue))
		.reduce(
			(acc, row) => acc.set(row.bucket, (acc.get(row.bucket) ?? 0) + row.value),
			new Map<string, number>(),
		)
	return [
		...rows.filter((row) => keep.has(row.attributeValue)),
		...[...pooled].map(([bucket, value]) => ({ bucket, attributeValue: BREAKDOWN_OTHER_KEY, value })),
	]
}

export type StackedBreakdownOptions = Readonly<{
	rows: ReadonlyArray<LongRow>
	/** Fixed colours (CSS values) for a closed vocabulary. */
	colors: Readonly<Record<string, string>>
	/** Fixed stack order; unlisted series append after, alphabetically. */
	order: ReadonlyArray<string>
	theme: ThemeColors
	timeZone: string
	gradientPrefix: string
}>

export type StackedBreakdown = Readonly<{
	spec: StackedBreakdownSpec
	/** Series in stack order with their unresolved colour, for the card's legend. */
	legend: ReadonlyArray<Readonly<{ name: string; label: string; color: string }>>
	isEmpty: boolean
}>

export const stackedBreakdown = (options: StackedBreakdownOptions): StackedBreakdown => {
	const bounded = options.order.length > 0 ? options.rows : foldTail(options.rows)
	const transformed = transformRows(bounded)
	const rank = new Map(options.order.map((name, index) => [name, index]))
	const rankOf = (name: string) =>
		name === BREAKDOWN_OTHER_KEY ? Number.MAX_SAFE_INTEGER : (rank.get(name) ?? options.order.length)
	const series = [...transformed.series].toSorted((a, b) => rankOf(a) - rankOf(b) || a.localeCompare(b))
	const identityColors = resolveSeriesColors(
		series.filter((name) => options.colors[name] === undefined && name !== BREAKDOWN_OTHER_KEY),
	)
	const paletteOf = (name: string) =>
		options.colors[name] ??
		(name === BREAKDOWN_OTHER_KEY ? OTHER_COLOR : (identityColors.get(name) ?? OTHER_COLOR))
	const legend = series.map((name) => ({ name, label: breakdownSeriesLabel(name), color: paletteOf(name) }))
	return {
		legend,
		isEmpty: transformed.data.length === 0,
		spec: {
			_tag: "StackedBreakdown",
			rows: bounded,
			series,
			labels: Object.fromEntries(legend.map(({ name, label }) => [name, label])),
			colors: Object.fromEntries([
				...legend.map(({ name, color }) => [name, resolveColor(options.theme, color)] as const),
				["border", resolveColor(options.theme, "--border")],
				["background", resolveColor(options.theme, "--background")],
			]),
			timeZone: options.timeZone,
			gradientPrefix: options.gradientPrefix,
		},
	}
}
