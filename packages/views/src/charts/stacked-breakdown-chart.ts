import { BREAKDOWN_OTHER_KEY, BREAKDOWN_OTHER_LABEL } from "../lib/cloudflare-constants"
import { resolveSeriesColors } from "@maple/ui/lib/semantic-series-colors"
import type { ChartSpec } from "./chart-spec"
import { type LongRow, transformRows } from "./infra-metric-series"
import { resolveColor, type ThemeColors } from "./theme-colors"
import { Array as Arr, Record as Rec, String as Str } from "effect"

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
	const totals = Arr.reduce(rows, new Map<string, number>(), (acc, row) =>
		acc.set(row.attributeValue, (acc.get(row.attributeValue) ?? 0) + row.value),
	)
	if (totals.size <= MAX_SERIES + 1) return rows
	const keep = new Set(
		Arr.map([...totals.entries()].toSorted((a, b) => b[1] - a[1]).slice(0, MAX_SERIES), ([name]) => name),
	)
	const pooled = Arr.reduce(
		Arr.filter(rows, (row) => !keep.has(row.attributeValue)),
		new Map<string, number>(),
		(acc, row) => acc.set(row.bucket, (acc.get(row.bucket) ?? 0) + row.value),
	)
	return [
		...Arr.filter(rows, (row) => keep.has(row.attributeValue)),
		...Arr.map([...pooled], ([bucket, value]) => ({
			bucket,
			attributeValue: BREAKDOWN_OTHER_KEY,
			value,
		})),
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
	unit?: StackedBreakdownSpec["unit"]
	showTotal?: boolean
	xDomainMs?: readonly [number, number]
	marginLeft?: number
	breaks?: ReadonlyArray<string>
	marginTop?: number | undefined
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
	const rank = new Map(Arr.map(options.order, (name, index) => [name, index]))
	const rankOf = (name: string) =>
		name === BREAKDOWN_OTHER_KEY ? Number.MAX_SAFE_INTEGER : (rank.get(name) ?? options.order.length)
	const series = [...transformed.series].toSorted(
		(a, b) => rankOf(a) - rankOf(b) || Str.localeCompare(b)(a),
	)
	const identityColors = resolveSeriesColors(
		Arr.filter(series, (name) => options.colors[name] === undefined && name !== BREAKDOWN_OTHER_KEY),
	)
	const paletteOf = (name: string) =>
		options.colors[name] ??
		(name === BREAKDOWN_OTHER_KEY ? OTHER_COLOR : (identityColors.get(name) ?? OTHER_COLOR))
	const legend = Arr.map(series, (name) => ({
		name,
		label: breakdownSeriesLabel(name),
		color: paletteOf(name),
	}))
	return {
		legend,
		isEmpty: transformed.data.length === 0,
		spec: {
			_tag: "StackedBreakdown",
			rows: bounded,
			series,
			labels: Rec.fromEntries(Arr.map(legend, ({ name, label }) => [name, label])),
			colors: Rec.fromEntries([
				...Arr.map(legend, ({ name, color }) => [name, resolveColor(options.theme, color)] as const),
				["border", resolveColor(options.theme, "--border")],
				["background", resolveColor(options.theme, "--background")],
			]),
			timeZone: options.timeZone,
			gradientPrefix: options.gradientPrefix,
			...(options.unit === undefined ? undefined : { unit: options.unit }),
			...(options.showTotal === undefined ? undefined : { showTotal: options.showTotal }),
			...(options.xDomainMs === undefined ? undefined : { xDomainMs: [...options.xDomainMs] }),
			...(options.marginLeft === undefined ? undefined : { marginLeft: options.marginLeft }),
			...(options.breaks === undefined ? undefined : { breaks: [...options.breaks] }),
			...(options.marginTop === undefined ? undefined : { marginTop: options.marginTop }),
		},
	}
}
