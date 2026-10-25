import { cn } from "@maple/ui/lib/utils"
import { miniBarsStyles } from "@maple/ui/styles/ui/mini-bars"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/mini-bars.tsx: a static bar sparkline in one <svg>.

const finite = (value: number): number => (Number.isFinite(value) && value > 0 ? value : 0)

export interface MiniBarsOptions {
	/** Bucket values, oldest first. Negative and non-finite values draw as zero. */
	readonly values: ReadonlyArray<number>
	readonly color?: string
	readonly floor?: number
	readonly floorColor?: string
	readonly minHeight?: number
	readonly gap?: number
	readonly opacityRamp?: boolean
	readonly tail?: number
	readonly className?: string
	/** Accessible name; the bars are decorative without one. */
	readonly label?: string
}

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
	const gap = options.gap ?? 2
	const count = values.length
	const max = count > 0 ? Math.max(...values.map(finite)) : 0
	const barWidth = Math.max((100 - gap * (count - 1)) / Math.max(count, 1), 0.5)
	const tail = options.tail
	const tailStart = tail === undefined ? 0 : count - Math.max(1, Math.round(count * tail))
	const bars = values.flatMap((raw, index) => {
		const value = finite(raw)
		const x = index * (barWidth + gap)
		const dim = index < tailStart
		if (value === 0) {
			if (floor <= 0) return []
			const opacity = options.floorColor ? 1 : dim ? 0.2 : 0.3
			return [bar(h, x, 100 - floor, barWidth, floor, options.floorColor ?? color, opacity)]
		}
		const ratio = max > 0 ? value / max : 0
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
