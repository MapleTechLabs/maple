import { formatNumber } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import { Effect, Queue, Schema, Stream } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { formatValue, type RangeUnit } from "./range-format"

// `RangeHistogram` (packages/ui/src/components/filters/range-filter-section.tsx): the distribution
// above a range's inputs. A press on one bar sets "at least this"; a drag across bars sets both
// bounds; hover names the bucket, and a drag in progress tints the range it would select.

export type RangeBucket = Readonly<{ from: number; to: number; count: number; unbounded?: boolean }>

export const HistogramMessage = defineMessageUnion({
	/** The bar under the pointer; `dragStart` is the bar a press went down on, while it is held. */
	PointedHistogramBar: { index: Schema.Number, dragStart: Schema.optional(Schema.Number) },
	LeftHistogram: {},
	SelectedHistogramRange: {
		min: Schema.UndefinedOr(Schema.Number),
		max: Schema.UndefinedOr(Schema.Number),
	},
})
export type HistogramMessage = typeof HistogramMessage.Type

const Bound = Schema.Struct({ from: Schema.Number, to: Schema.Number, unbounded: Schema.Boolean })

/** A count bucket's last member is `to - 1`: the bound a selection writes. */
const lastOfBound = (bound: typeof Bound.Type, isCount: boolean): number =>
	isCount ? bound.to - 1 : bound.to

/** Pointer capture on the bars. */
export const MountRangeHistogram = Mount.defineStream("MountRangeHistogram", {
	args: { bounds: Schema.Array(Bound), isCount: Schema.Boolean },
	messages: [
		HistogramMessage.PointedHistogramBar,
		HistogramMessage.LeftHistogram,
		HistogramMessage.SelectedHistogramRange,
	],
	execute: ({ element, bounds, isCount }) =>
		Stream.callback<HistogramMessage>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const state = { dragStart: -1 }
					const indexAt = (clientX: number): number => {
						const rect = element.getBoundingClientRect()
						if (rect.width === 0) return 0
						const ratio = (clientX - rect.left) / rect.width
						return Math.min(bounds.length - 1, Math.max(0, Math.floor(ratio * bounds.length)))
					}
					const onDown = (event: Event) => {
						if (!(event instanceof PointerEvent)) return
						state.dragStart = indexAt(event.clientX)
						Queue.offerUnsafe(
							queue,
							HistogramMessage.PointedHistogramBar({
								index: state.dragStart,
								dragStart: state.dragStart,
							}),
						)
						if (event.currentTarget instanceof Element)
							event.currentTarget.setPointerCapture(event.pointerId)
					}
					const onMove = (event: Event) =>
						event instanceof PointerEvent &&
						Queue.offerUnsafe(
							queue,
							HistogramMessage.PointedHistogramBar({
								index: indexAt(event.clientX),
								dragStart: state.dragStart === -1 ? undefined : state.dragStart,
							}),
						)
					const onUp = (event: Event) => {
						if (!(event instanceof PointerEvent)) return
						if (state.dragStart === -1) return
						const end = indexAt(event.clientX)
						const lo = Math.min(state.dragStart, end)
						const hi = Math.max(state.dragStart, end)
						state.dragStart = -1
						const bottom = bounds[lo]
						const top = bounds[hi]
						if (bottom === undefined || top === undefined) return
						Queue.offerUnsafe(
							queue,
							HistogramMessage.SelectedHistogramRange({
								min: bottom.from,
								max: lo === hi || top.unbounded ? undefined : lastOfBound(top, isCount),
							}),
						)
					}
					const onLeave = () => Queue.offerUnsafe(queue, HistogramMessage.LeftHistogram())
					element.addEventListener("pointerdown", onDown)
					element.addEventListener("pointermove", onMove)
					element.addEventListener("pointerup", onUp)
					element.addEventListener("pointerleave", onLeave)
					return () => {
						element.removeEventListener("pointerdown", onDown)
						element.removeEventListener("pointermove", onMove)
						element.removeEventListener("pointerup", onUp)
						element.removeEventListener("pointerleave", onLeave)
					}
				}),
				(release) => Effect.sync(release),
			),
		),
})

export type RangeHistogramConfig<M> = Readonly<{
	buckets: ReadonlyArray<RangeBucket>
	unit: RangeUnit
	unitLabel: string
	title: string
	minValue: number | undefined
	maxValue: number | undefined
	/** The bar under the pointer, which the readout names. */
	hoveredIndex: number | undefined
	/** The bar a held press went down on: the drag's other end. */
	dragStart?: number | undefined
	toMessage: (message: HistogramMessage) => M
}>

export const rangeHistogram = <M>(h: HtmlBuilder<M>, config: RangeHistogramConfig<M>): Html | null => {
	const { buckets, unit } = config
	const first = buckets[0]
	const last = buckets.at(-1)
	if (first === undefined || last === undefined) return null
	const peak = Math.max(...buckets.map((bucket) => bucket.count), 1)
	const total = buckets.reduce((sum, bucket) => sum + bucket.count, 0)
	const lastOf = (bucket: RangeBucket): number => (unit === "count" ? bucket.to - 1 : bucket.to)
	const describe = (bucket: RangeBucket): string => {
		if (bucket.unbounded === true) return `≥ ${formatValue(bucket.from, unit)}`
		if (lastOf(bucket) === bucket.from) return formatValue(bucket.from, unit)
		return `${formatValue(bucket.from, unit)} – ${formatValue(lastOf(bucket), unit)}`
	}
	// While dragging, the pending selection is previewed instead of the applied one.
	const preview =
		config.dragStart !== undefined && config.hoveredIndex !== undefined
			? {
					lo: Math.min(config.dragStart, config.hoveredIndex),
					hi: Math.max(config.dragStart, config.hoveredIndex),
				}
			: undefined
	const hasSelection =
		config.minValue !== undefined || config.maxValue !== undefined || preview !== undefined
	const isSelected = (bucket: RangeBucket, index: number): boolean => {
		if (preview !== undefined) return index >= preview.lo && index <= preview.hi
		if (config.minValue === undefined && config.maxValue === undefined) return false
		return (
			(config.maxValue === undefined ||
				bucket.from < (unit === "count" ? config.maxValue + 1 : config.maxValue)) &&
			(config.minValue === undefined || bucket.to > config.minValue)
		)
	}
	const hovered = config.hoveredIndex === undefined ? undefined : buckets[config.hoveredIndex]
	const middle = buckets[Math.floor(buckets.length / 2)] ?? first
	const bounds = buckets.map((bucket) => ({
		from: bucket.from,
		to: bucket.to,
		unbounded: bucket.unbounded === true,
	}))
	return h.div(
		[],
		[
			h.div(
				[
					h.Class(
						"mb-1 flex h-4 items-center justify-between text-3xs tabular-nums text-muted-foreground",
					),
				],
				hovered === undefined
					? [h.span([], [formatNumber(total), " ", config.unitLabel])]
					: [
							h.span([], [describe(hovered)]),
							h.span([h.Class("text-foreground")], [formatNumber(hovered.count)]),
						],
			),
			h.div(
				[
					// New buckets (a facets refetch) remount the handlers, which captured the old bounds.
					h.Key(
						bounds
							.map((bound) => `${bound.from}-${bound.to}${bound.unbounded ? "+" : ""}`)
							.join(","),
					),
					h.AriaLabel(
						`${config.title} distribution across ${buckets.length} buckets, from ${formatValue(first.from, unit)} to ${last.unbounded === true ? `over ${formatValue(last.from, unit)}` : formatValue(lastOf(last), unit)}`,
					),
					h.Class("flex h-8 cursor-crosshair touch-none items-end gap-px"),
					h.Role("img"),
					h.OnMount(
						Mount.mapMessage(
							MountRangeHistogram({ bounds, isCount: unit === "count" }),
							config.toMessage,
						),
					),
				],
				buckets.map((bucket, index) =>
					h.div(
						[
							h.Key(String(bucket.from)),
							h.Class(
								cn(
									"min-w-px flex-1 rounded-t-2xs motion-safe:transition-[height,background-color] duration-150",
									index === config.hoveredIndex
										? "bg-foreground/60"
										: isSelected(bucket, index)
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
			h.div(
				[h.Class("mt-1 flex justify-between text-3xs tabular-nums text-foreground-subtle")],
				[
					h.span([], [formatValue(first.from, unit)]),
					h.span([], [formatValue(middle.from, unit)]),
					h.span(
						[],
						[
							last.unbounded === true
								? `${formatValue(last.from, unit)}+`
								: formatValue(lastOf(last), unit),
						],
					),
				],
			),
		],
	)
}
