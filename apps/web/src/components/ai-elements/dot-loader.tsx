import { useState, type ComponentType } from "react"
import { cn } from "@maple/ui/lib/utils"
import type { DotMatrixCommonProps } from "@/lib/dotmatrix-core"
import { Dotm3x3_1 } from "@/components/ui/dotm-3x3-1"
import { Dotm3x3_6 } from "@/components/ui/dotm-3x3-6"
import { Dotm3x3_7 } from "@/components/ui/dotm-3x3-7"
import { Dotm3x3_8 } from "@/components/ui/dotm-3x3-8"
import { Dotm3x3_10 } from "@/components/ui/dotm-3x3-10"
import { Dotm3x3_12 } from "@/components/ui/dotm-3x3-12"
import { Dotm3x3_13 } from "@/components/ui/dotm-3x3-13"
import { Dotm3x3_15 } from "@/components/ui/dotm-3x3-15"
import { DotmSquare1 } from "@/components/ui/dotm-square-1"
import { DotmSquare3 } from "@/components/ui/dotm-square-3"
import { DotmSquare4 } from "@/components/ui/dotm-square-4"
import { DotmSquare5 } from "@/components/ui/dotm-square-5"
import { DotmSquare6 } from "@/components/ui/dotm-square-6"
import { DotmSquare9 } from "@/components/ui/dotm-square-9"
import { DotmSquare11 } from "@/components/ui/dotm-square-11"
import { DotmSquare12 } from "@/components/ui/dotm-square-12"

type DotVariant = ComponentType<DotMatrixCommonProps>

export type DotLoaderSize = 14 | 18

/**
 * The loaders the chat draws from, all from the dot-matrix family.
 *
 * Every entry is a lit dot grid on the same rhythm, so which one you get never changes what the
 * chrome *means* — only its motion. That is the whole reason the pool can be random: the
 * previous glyph mapped four animations onto tool categories, which asked the reader to learn a
 * vocabulary that the row's own text already spelled out.
 *
 * Each entry carries only how many dots a side it has; `GEOMETRY` turns that into a grid that
 * fills the caller's box exactly, so a swap never moves the line the loader sits on.
 *
 * Every entry is deliberately one of the registry's CSS-only loaders. A handful of the others
 * (Core Rotor, Sound Bars, Comet Trail) step their frames from a JS interval that calls
 * `setState`, and this glyph's whole job is to sit on screen through a streaming turn — a
 * render every 90ms on that path is the one cost the chat chrome has never paid.
 */
export interface DotLoaderVariant {
	name: string
	Component: DotVariant
	grid: 3 | 5
}

export const DOT_LOADER_VARIANTS: ReadonlyArray<DotLoaderVariant> = [
	{ name: "Neon Drift", Component: DotmSquare1, grid: 5 },
	{ name: "Core Spiral", Component: DotmSquare3, grid: 5 },
	{ name: "Twin Orbit", Component: DotmSquare4, grid: 5 },
	{ name: "Prism Sweep", Component: DotmSquare5, grid: 5 },
	{ name: "Flux Columns", Component: DotmSquare6, grid: 5 },
	{ name: "Glyph Pulse", Component: DotmSquare9, grid: 5 },
	{ name: "Echo Ring", Component: DotmSquare11, grid: 5 },
	{ name: "Origin Wave", Component: DotmSquare12, grid: 5 },
	{ name: "Square Spiral", Component: Dotm3x3_1, grid: 3 },
	{ name: "Core Echo", Component: Dotm3x3_6, grid: 3 },
	{ name: "Column Flux", Component: Dotm3x3_7, grid: 3 },
	{ name: "Row Sweep", Component: Dotm3x3_8, grid: 3 },
	{ name: "Frame Chase", Component: Dotm3x3_10, grid: 3 },
	{ name: "Drop Ripple", Component: Dotm3x3_12, grid: 3 },
	{ name: "Right Surge", Component: Dotm3x3_13, grid: 3 },
	{ name: "Echo Rings", Component: Dotm3x3_15, grid: 3 },
]

/** Total number of distinct animations in the pool. Exported so tests can assert the variety. */
export const DOT_LOADER_VARIANT_COUNT = DOT_LOADER_VARIANTS.length

/**
 * Dot size and cell padding per grid, per box — chosen so `dots * dotSize + (dots - 1) * padding`
 * is exactly the box, on both grids.
 *
 * Both are passed explicitly because `size` alone does not survive the matrix: the 3×3 base
 * defaults `cellPadding` to 1, and any `cellPadding` makes the layout derive the span from the
 * dots and ignore `size` outright. Left implicit, every 3×3 rendered 14px wide inside an 18px
 * box and sat visibly small and off-centre next to its 5×5 siblings.
 */
const GEOMETRY = {
	14: {
		3: { dotSize: 4, cellPadding: 1 },
		5: { dotSize: 2, cellPadding: 1 },
	},
	18: {
		3: { dotSize: 4, cellPadding: 3 },
		5: { dotSize: 2, cellPadding: 2 },
	},
} satisfies Record<DotLoaderSize, Record<3 | 5, { dotSize: number; cellPadding: number }>>

/**
 * The floor every dot rests at, overriding a default of 0.06 on the 3×3 grid that let unlit dots
 * disappear completely. A loader whose off state is invisible reads as a blinking mark rather
 * than a lit grid with something moving across it, which at this size is the difference between
 * a glyph you can leave on screen for a whole turn and one you can't.
 */
const OPACITY_BASE = 0.2

/**
 * Speed multiplier on the matrix's 1500ms base loop, so every variant runs one pass in 2.5s
 * regardless of the default its own file ships (those range from 1.15 to 1.75, i.e. roughly
 * one pass a second, which at 18px is a twitch rather than a rhythm).
 *
 * One rate for the whole pool matters as much as the rate itself: a random pick that also
 * randomised tempo would make the chrome feel unstable between turns.
 */
const SPEED = 0.6

interface DotLoaderProps {
	/**
	 * Accessible name. Omit for the common case where adjacent text already says what is
	 * happening — the loader is then hidden from the accessibility tree rather than adding a
	 * second live region that announces the same thing.
	 */
	label?: string
	/** Ink. Defaults to `currentColor` so the loader takes the tone of the row it sits in. */
	color?: string
	/** Span of the grid in px. 18 suits a 20px glyph column; 14 matches a `size-3.5` icon. */
	size?: DotLoaderSize
	/**
	 * Pin the animation instead of rolling one. Only the lab passes this — it exists so the
	 * gallery shows the pool through the same component the chat uses, rather than a copy of
	 * this file's geometry that could drift away from it.
	 */
	variant?: DotLoaderVariant
	className?: string
}

/**
 * The chat's "working" glyph: one dot-matrix loader, picked at random when it mounts.
 *
 * The pick is per-mount rather than per-render, so a loader keeps its animation for as long as
 * the thing it reports on is in flight; a new thinking row, tool burst or sidebar tab rolls
 * again. Nothing here re-enters React while a turn streams — the animation is CSS on
 * static dots, and `prefers-reduced-motion` is handled inside the matrix, which paints a single
 * resting frame instead of starting a loop.
 */
export function DotLoader({
	label,
	color = "currentColor",
	size = 18,
	variant,
	className,
}: DotLoaderProps) {
	const [rolled] = useState(
		() =>
			DOT_LOADER_VARIANTS[
				Math.floor(Math.random() * DOT_LOADER_VARIANTS.length)
			] as DotLoaderVariant,
	)
	const { Component, grid } = variant ?? rolled
	const { dotSize, cellPadding } = GEOMETRY[size][grid]

	// The wrapper, not the matrix, carries `className`: callers stack this in a grid cell or a
	// crossfade layer, and those classes have to land on the outermost node to have any effect.
	return (
		<span
			aria-hidden={label === undefined ? "true" : undefined}
			className={cn("inline-flex shrink-0 items-center justify-center", className)}
		>
			<Component
				size={size}
				dotSize={dotSize}
				cellPadding={cellPadding}
				opacityBase={OPACITY_BASE}
				speed={SPEED}
				// Square dots, not circles: this is a pixel grid, which is the language the rest of
				// Maple's small marks are drawn in.
				dotMark="square"
				color={color}
				ariaLabel={label ?? "Loading"}
			/>
		</span>
	)
}
