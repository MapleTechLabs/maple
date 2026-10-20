import "../../../components/dotmatrix-loader.css"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

// The dot loader over `Dotm3x3_6`: a 3×3 matrix of 4 px square dots breathing out from its
// centre. Each dot carries the animation class and the reduced-motion resting opacity inline:
// the animation wins, and the media query that turns it off leaves the resting frame.

const DOT_SIZE = 4
const GAP = 1
const SPAN = DOT_SIZE * 3 + GAP * 2
const OPACITY_BASE = 0.2
const SPEED_SCALE = 1600 / 1230

/** `remapOpacityToTriplet` with only `opacityBase` overridden (mid 0.34, peak 0.94 kept). */
const remap = (opacity: number): number => {
	const lerp = (from: number, to: number, start: number, end: number) =>
		from + (to - from) * Math.min(1, Math.max(0, (opacity - start) / (end - start)))
	if (opacity <= 0.08) return lerp(0, OPACITY_BASE, 0, 0.08)
	if (opacity <= 0.34) return lerp(OPACITY_BASE, 0.34, 0.08, 0.34)
	if (opacity <= 0.94) return lerp(0.34, 0.94, 0.34, 0.94)
	return lerp(0.94, 1, 0.94, 1)
}

const dot = <M>(h: HtmlBuilder<M>, index: number): Html => {
	const row = Math.floor(index / 3)
	const col = index % 3
	const dx = col - 1
	const dy = row - 1
	const manhattan = Math.abs(dx) + Math.abs(dy)
	const ring = Math.max(0, Math.min(2, manhattan))
	return h.span(
		[
			h.AriaHidden(true),
			h.Class("dmx-dot dmx-center-ripple-3"),
			h.Style({
				width: `${DOT_SIZE}px`,
				height: `${DOT_SIZE}px`,
				"--dmx-distance": String(Math.hypot(dx, dy)),
				"--dmx-row": String(row),
				"--dmx-col": String(col),
				"--dmx-x": `${dx * (DOT_SIZE + GAP)}px`,
				"--dmx-y": `${dy * (DOT_SIZE + GAP)}px`,
				"--dmx-angle": String(Math.atan2(dy, dx)),
				"--dmx-radius": String(Math.hypot(dx, dy) / Math.SQRT2),
				"--dmx-manhattan": String(manhattan),
				"--dmx-center-ripple-ring": String(ring),
				opacity: String(remap(0.06 + (1 - ring / 2) * 0.82)),
				"--dmx-bloom-level": "0",
			}),
		],
		[],
	)
}

export type DotLoaderOptions = Readonly<{
	/** Accessible name; omitted, the loader is hidden from assistive tech. */
	label?: string
	color?: string
	className?: string
}>

export const dotLoader = <M>(h: HtmlBuilder<M>, options: DotLoaderOptions = {}): Html => {
	const color = options.color ?? "currentColor"
	return h.span(
		[
			...(options.label === undefined ? [h.AriaHidden(true)] : []),
			h.Class(cn("inline-flex shrink-0 items-center justify-center", options.className)),
		],
		[
			h.div(
				[
					h.AriaLabel(options.label ?? "Loading"),
					h.AriaLive("polite"),
					h.Class("dmx-root dmx-matrix-3 dmx-dot-shape-square"),
					h.Role("status"),
					h.Style({
						width: `${SPAN}px`,
						height: `${SPAN}px`,
						"--dmx-speed": String(SPEED_SCALE),
						"--dmx-dot-size": `${DOT_SIZE}px`,
						"--dmx-halo-level": "0",
						"--dmx-dot-fill": color,
						color,
						"--dmx-opacity-base": String(OPACITY_BASE),
					}),
				],
				[
					h.div(
						[
							h.Class("dmx-grid"),
							h.Style({
								gap: `${GAP}px`,
								"grid-template-columns": "repeat(3, minmax(0, 1fr))",
								"grid-template-rows": "repeat(3, minmax(0, 1fr))",
							}),
						],
						[0, 1, 2, 3, 4, 5, 6, 7, 8].map((index) => dot(h, index)),
					),
				],
			),
		],
	)
}
