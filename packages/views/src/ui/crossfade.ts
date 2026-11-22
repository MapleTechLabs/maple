import { cn } from "@maple/ui/lib/utils"
import { Array as Arr } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

/**
 * `crossfade`: a few states stacked in one grid cell, the shown one faded in and the rest out, so
 * a swap never blinks or shifts the layout. Every layer stays mounted; hidden ones are aria-hidden.
 */

const VARIANT = {
	/** A glyph: the hidden one shrinks back a little (spinner into a check). */
	glyph: {
		layer: "transition-[opacity,scale] duration-240 ease-out",
		hidden: "scale-[0.92] opacity-0",
	},
	/** Text: the hidden one blurs out; a layer's `hiddenClassName` picks the way it leaves. */
	text: {
		layer: "transition-[opacity,translate,filter] duration-300 ease-out",
		hidden: "opacity-0 blur-xs",
	},
} as const

export type CrossfadeLayer = Readonly<{
	isShown: boolean
	children: ReadonlyArray<Html | string>
	/** Added while hidden, such as `-translate-y-1.5` for a layer that leaves upward. */
	hiddenClassName?: string
	className?: string
}>

export type CrossfadeOptions = Readonly<{
	variant: keyof typeof VARIANT
	as?: "span" | "div"
	className?: string
}>

export const crossfade = <M>(
	h: HtmlBuilder<M>,
	options: CrossfadeOptions,
	layers: ReadonlyArray<CrossfadeLayer>,
): Html => {
	const variant = VARIANT[options.variant]
	const element = options.as === "div" ? h.div : h.span
	return element(
		[h.Class(cn("grid place-items-center", options.className))],
		Arr.map(layers, (layer) =>
			element(
				[
					h.Class(
						cn(
							"col-start-1 row-start-1 motion-reduce:transition-opacity",
							variant.layer,
							layer.className,
							!layer.isShown &&
								cn("pointer-events-none", variant.hidden, layer.hiddenClassName),
						),
					),
					h.AriaHidden(!layer.isShown),
				],
				layer.children,
			),
		),
	)
}
