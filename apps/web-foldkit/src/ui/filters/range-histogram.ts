import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { formatValue, type RangeUnit } from "./range-format"

// `RangeHistogram` (packages/ui/src/components/filters/range-filter-section.tsx) and the bucket
// helpers of apps/web/src/components/filters/range-distribution.ts (both import React modules).
// TODO(histogram-drag): a click on a bar sets the floor; drag-to-select and the hover readout are
// not ported (the readout always shows the total).

export type RangeBucket = Readonly<{ from: number; to: number; count: number; unbounded?: boolean }>

const AXIS_COVERAGE = 0.99

/** `toLogBuckets`: the warehouse's non-empty log buckets rebuilt into a continuous run. */
export const toLogBuckets = (
	raw: ReadonlyArray<{ readonly floor: number; readonly count: number }>,
	stepsPerOctave: number,
): ReadonlyArray<RangeBucket> => {
	const counts = new Map(
		raw
			.filter((item) => Number.isFinite(item.floor) && item.floor > 0)
			.map((item) => [Math.round(Math.log2(item.floor) * stepsPerOctave), item.count] as const),
	)
	if (counts.size === 0) return []
	const steps = [...counts.keys()]
	const low = Math.min(...steps)
	const buckets = Array.from({ length: Math.max(...steps) - low + 1 }, (_, i) => ({
		from: 2 ** ((low + i) / stepsPerOctave),
		to: 2 ** ((low + i + 1) / stepsPerOctave),
		count: counts.get(low + i) ?? 0,
	}))
	const total = buckets.reduce((sum, b) => sum + b.count, 0)
	if (total === 0) return buckets
	const cumulative = buckets.reduce<ReadonlyArray<number>>((acc, b) => [...acc, (acc.at(-1) ?? 0) + b.count], [])
	const index = cumulative.findIndex((covered) => covered >= total * AXIS_COVERAGE)
	if (index === -1) return buckets
	const tail = buckets.slice(index + 1)
	const tailCount = tail.reduce((sum, b) => sum + b.count, 0)
	const [firstTail] = tail
	if (tailCount === 0 || firstTail === undefined) return buckets.slice(0, index + 1)
	return [
		...buckets.slice(0, index + 1),
		{ from: firstTail.from, to: Number.POSITIVE_INFINITY, count: tailCount, unbounded: true },
	]
}

const MIN_THRESHOLD = { ms: 1, s: 1 } satisfies Record<RangeUnit, number>

const roundThreshold = (value: number, unit: RangeUnit): number =>
	unit === "s" ? (value < 60 ? Math.round(value) : Math.round(value / 60) * 60) : Number(value.toPrecision(2))

/** `percentilePresets`: "> p50" and "> p95", skipping a threshold too small or equal to the last. */
export const percentilePresets = (p50: number, p95: number, unit: RangeUnit) =>
	(
		[
			["p50", p50],
			["p95", p95],
		] as const
	).reduce<ReadonlyArray<{ key: string; label: string; value: string; min: number }>>((presets, [key, value]) => {
		const threshold = roundThreshold(value, unit)
		return threshold < MIN_THRESHOLD[unit] || presets.some((preset) => preset.min === threshold)
			? presets
			: [...presets, { key, label: `> ${key}`, value: formatValue(threshold, unit), min: threshold }]
	}, [])

export type RangeHistogramConfig<M> = Readonly<{
	buckets: ReadonlyArray<RangeBucket>
	unit: RangeUnit
	unitLabel: string
	title: string
	minValue: number | undefined
	maxValue: number | undefined
	onApply: (min: number | undefined, max: number | undefined) => M
}>

export const rangeHistogram = <M>(h: HtmlBuilder<M>, config: RangeHistogramConfig<M>): Html | null => {
	const { buckets, unit } = config
	const first = buckets[0]
	const last = buckets.at(-1)
	if (first === undefined || last === undefined) return null
	const peak = Math.max(...buckets.map((b) => b.count), 1)
	const total = buckets.reduce((sum, b) => sum + b.count, 0)
	const hasSelection = config.minValue !== undefined || config.maxValue !== undefined
	const isSelected = (bucket: RangeBucket) =>
		hasSelection &&
		(config.maxValue === undefined || bucket.from < config.maxValue) &&
		(config.minValue === undefined || bucket.to > config.minValue)
	const middle = buckets[Math.floor(buckets.length / 2)] ?? first
	return h.div([], [
		h.div(
			[h.Class("mb-1 flex h-4 items-center justify-between text-3xs tabular-nums text-muted-foreground")],
			[h.span([], [formatNumber(total), " ", config.unitLabel])],
		),
		h.div(
			[
				h.Role("img"),
				h.AriaLabel(
					`${config.title} distribution across ${buckets.length} buckets, from ${formatValue(first.from, unit)} to ${last.unbounded === true ? `over ${formatValue(last.from, unit)}` : formatValue(last.to, unit)}`,
				),
				h.Class("flex h-8 cursor-crosshair touch-none items-end gap-px"),
			],
			buckets.map((bucket) =>
				h.div(
					[
						h.Key(String(bucket.from)),
						h.OnClick(config.onApply(bucket.from, undefined)),
						h.Class(
							cn(
								"min-w-px flex-1 rounded-t-[1px] motion-safe:transition-[height,background-color] duration-150",
								isSelected(bucket)
									? "bg-primary/70"
									: hasSelection
										? "bg-muted-foreground/15"
										: "bg-muted-foreground/30",
							),
						),
						h.Style({
							height: `${bucket.count === 0 ? 2 : Math.max(8, Math.sqrt(bucket.count / peak) * 100)}%`,
						}),
					],
					[],
				),
			),
		),
		h.div([h.Class("mt-1 flex justify-between text-3xs tabular-nums text-muted-foreground/60")], [
			h.span([], [formatValue(first.from, unit)]),
			h.span([], [formatValue(middle.from, unit)]),
			h.span([], [last.unbounded === true ? `${formatValue(last.from, unit)}+` : formatValue(last.to, unit)]),
		]),
	])
}
