import { cn } from "@maple/ui/lib/utils"
import { miniBarsStyles } from "./mini-bars.styles"
import type { Html, HtmlBuilder } from "foldkit/html"
import { Array as Arr } from "effect"

// A static bar sparkline in one <svg>.

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

export interface MiniBarsOptions {
	/** Bucket values, oldest first. Negative and non-finite values draw as zero. */
	readonly values: ReadonlyArray<number>
	readonly color?: string
	readonly floor?: number
	/** The value a full-height bar stands for; default the largest value. `1` draws ratios as 0-100%. */
	readonly max?: number
	readonly floorColor?: string
	readonly minHeight?: number
	readonly gap?: number
	readonly opacityRamp?: boolean
	readonly tail?: number
	readonly className?: string
	/** Accessible name; the bars are decorative without one. */
	readonly label?: string
}

/**
 * Bar width and gap in the 100-unit view box. The gap shrinks to at most half a slot, so any number
 * of bars fits inside the box and the newest are never drawn past its edge.
 */
export const miniBarsLayout = (
	count: number,
	gap: number,
): { readonly barWidth: number; readonly gap: number } => {
	const slots = Math.max(count, 1)
	const fitted = Math.min(gap, 50 / slots)
	return { barWidth: (100 - fitted * (slots - 1)) / slots, gap: fitted }
}

/** A bar's share of full height (0-1): its value over `max`, never past the top. */
export const miniBarsRatio = (value: number, max: number): number => (max > 0 ? Math.min(value / max, 1) : 0)

const bar = <M>(
	h: HtmlBuilder<M>,
	x: number,
	y: number,
	width: number,
	height: number,
	fill: string,
	opacity: number,
) =>
	h.rect([
		h.Attribute("x", String(x)),
		h.Attribute("y", String(y)),
		h.Attribute("width", String(width)),
		h.Attribute("height", String(height)),
		h.Attribute("fill", fill),
		h.Attribute("opacity", String(opacity)),
	])

export const miniBars = <M>(h: HtmlBuilder<M>, options: MiniBarsOptions): Html => {
	const { values, label } = options
	const color = options.color ?? "currentColor"
	const floor = options.floor ?? 0
	const minHeight = options.minHeight ?? 5
	const count = values.length
	const max = options.max ?? (count > 0 ? Math.max(...Arr.map(values, finite)) : 0)
	const { barWidth, gap } = miniBarsLayout(count, options.gap ?? 2)
	const tail = options.tail
	const tailStart = tail === undefined ? 0 : count - Math.max(1, Math.round(count * tail))
	const bars = Arr.flatMap(values, (raw, index) => {
		const value = finite(raw)
		const x = index * (barWidth + gap)
		const dim = index < tailStart
		if (value === 0) {
			if (floor <= 0) return []
			const opacity = options.floorColor ? 1 : dim ? 0.2 : 0.3
			return [bar(h, x, 100 - floor, barWidth, floor, options.floorColor ?? color, opacity)]
		}
		const ratio = miniBarsRatio(value, max)
		const height = Math.max(ratio * 100, minHeight)
		const opacity = (options.opacityRamp === true ? 0.3 + ratio * 0.7 : 1) * (dim ? 0.5 : 1)
		return [bar(h, x, 100 - height, barWidth, height, color, opacity)]
	})
	return h.svg(
		[
			h.Attribute("viewBox", "0 0 100 100"),
			h.Attribute("preserveAspectRatio", "none"),
			h.Attribute("class", cn(miniBarsStyles, options.className)),
			...(label
				? [h.Attribute("role", "img"), h.Attribute("aria-label", label)]
				: [h.Attribute("aria-hidden", "true")]),
			h.Attribute("data-slot", "mini-bars"),
		],
		[...(label ? [h.title([], [label])] : []), ...bars],
	)
}
