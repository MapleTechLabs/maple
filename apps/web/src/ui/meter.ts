import { TONE_FILL, type Tone } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import {
	backdropBarLeftStyles,
	backdropBarRightStyles,
	backdropBarStyles,
	meterFillStyles,
	meterFillUntonedStyles,
	meterStyles,
	segmentedBarSegmentStyles,
	segmentedBarStyles,
} from "@maple/ui/styles/ui/meter"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/meter.tsx: Meter, SegmentedBar and BackdropBar.

/** Width for a fraction: clamped to 0..1, and a non-zero value is never thinner than `minVisible`%. */
const widthPercent = (fraction: number, minVisible: number): number =>
	!Number.isFinite(fraction) || fraction <= 0 ? 0 : Math.max(Math.min(fraction, 1) * 100, minVisible)

export interface MeterOptions {
	readonly value: number
	readonly max?: number
	readonly minVisible?: number
	readonly tone?: Tone
	readonly fillClassName?: string
	readonly className?: string
	/** Accessible name; the bar is decorative without one. */
	readonly label?: string
}

export const meter = <M>(h: HtmlBuilder<M>, options: MeterOptions): Html => {
	const max = options.max ?? 1
	const fraction = max > 0 ? options.value / max : 0
	const label = options.label
	return h.div(
		[
			h.Class(cn(meterStyles, options.className)),
			h.DataAttribute("slot", "meter"),
			...(label
				? [
						h.Role("meter"),
						h.AriaLabel(label),
						h.Attribute("aria-valuenow", String(options.value)),
						h.Attribute("aria-valuemin", "0"),
						h.Attribute("aria-valuemax", String(max)),
					]
				: [h.AriaHidden(true)]),
		],
		[
			h.div([
				h.Class(
					cn(
						meterFillStyles,
						options.tone ? TONE_FILL[options.tone] : meterFillUntonedStyles,
						options.fillClassName,
					),
				),
				h.Style({ width: `${widthPercent(fraction, options.minVisible ?? 1.5)}%` }),
			]),
		],
	)
}

export interface BarSegment {
	readonly key: string
	readonly value: number
	readonly className?: string
	readonly color?: string
	readonly title?: string
}

const segmentStyle = (segment: BarSegment, sum: number, minVisible: number): Record<string, string> => {
	const width = `${Math.max((segment.value / sum) * 100, minVisible)}%`
	if (segment.color === undefined) return { width }
	return { width, "background-color": segment.color }
}

const segmentView = <M>(h: HtmlBuilder<M>, segment: BarSegment, sum: number, minVisible: number): Html =>
	h.div([
		...(segment.title === undefined ? [] : [h.Title(segment.title)]),
		h.Class(cn(segmentedBarSegmentStyles, segment.className)),
		h.Style(segmentStyle(segment, sum, minVisible)),
	])

/** Stacked composition bar: each segment's width is its share of the total. */
export const segmentedBar = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly segments: ReadonlyArray<BarSegment>
		readonly total?: number
		readonly minVisible?: number
		readonly label?: string
		readonly className?: string
	},
): Html => {
	const sum = options.total ?? options.segments.reduce((acc, s) => acc + Math.max(0, s.value), 0)
	const label = options.label
	return h.div(
		[
			h.Class(cn(segmentedBarStyles, options.className)),
			h.DataAttribute("slot", "segmented-bar"),
			...(label ? [h.Role("img"), h.AriaLabel(label)] : [h.AriaHidden(true)]),
		],
		sum > 0
			? options.segments
					.filter((segment) => segment.value > 0)
					.map((segment) => segmentView(h, segment, sum, options.minVisible ?? 0))
			: [],
	)
}

/** `BackdropBar`: a share-of-max bar behind a row's text; nothing for a zero share. */
export const backdropBar = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ value: number; max?: number; align?: "left" | "right"; className?: string }>,
): Html | null => {
	const max = options.max ?? 1
	const width = widthPercent(max > 0 ? options.value / max : 0, 0)
	if (width === 0) return null
	return h.div([
		h.AriaHidden(true),
		h.DataAttribute("slot", "backdrop-bar"),
		h.Class(
			cn(
				backdropBarStyles,
				(options.align ?? "left") === "left" ? backdropBarLeftStyles : backdropBarRightStyles,
				options.className,
			),
		),
		h.Style({ width: `calc(${width}% - 0.5rem)` }),
	])
}
