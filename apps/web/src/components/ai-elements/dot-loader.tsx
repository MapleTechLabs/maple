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

/**
 * The loaders the chat draws from, all from the dot-matrix family.
 *
 * Every entry is a lit dot grid on the same rhythm, so which one you get never changes what the
 * chrome *means* — only its motion. That is the whole reason the pool can be random: the
 * previous glyph mapped four animations onto tool categories, which asked the reader to learn a
 * vocabulary that the row's own text already spelled out.
 *
 * Each entry carries only its dot size; the span comes from the caller, and the two families
 * land on the same one (a 5×5 of 2px dots and a 3×3 of 4px dots both fill 18px, and both fill
 * 14px) so a swap never moves the line it sits on.
 *
 * Every entry is deliberately one of the registry's CSS-only loaders. A handful of the others
 * (Core Rotor, Sound Bars, Comet Trail) step their frames from a JS interval that calls
 * `setState`, and this glyph's whole job is to sit on screen through a streaming turn — a
 * render every 90ms on that path is the one cost the chat chrome has never paid.
 */
const VARIANTS: ReadonlyArray<{ Component: DotVariant; dotSize: number }> = [
	{ Component: DotmSquare1, dotSize: 2 },
	{ Component: DotmSquare3, dotSize: 2 },
	{ Component: DotmSquare4, dotSize: 2 },
	{ Component: DotmSquare5, dotSize: 2 },
	{ Component: DotmSquare6, dotSize: 2 },
	{ Component: DotmSquare9, dotSize: 2 },
	{ Component: DotmSquare11, dotSize: 2 },
	{ Component: DotmSquare12, dotSize: 2 },
	{ Component: Dotm3x3_1, dotSize: 4 },
	{ Component: Dotm3x3_6, dotSize: 4 },
	{ Component: Dotm3x3_7, dotSize: 4 },
	{ Component: Dotm3x3_8, dotSize: 4 },
	{ Component: Dotm3x3_10, dotSize: 4 },
	{ Component: Dotm3x3_12, dotSize: 4 },
	{ Component: Dotm3x3_13, dotSize: 4 },
	{ Component: Dotm3x3_15, dotSize: 4 },
]

/** Total number of distinct animations in the pool. Exported so tests can assert the variety. */
export const DOT_LOADER_VARIANT_COUNT = VARIANTS.length

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
	size?: 14 | 18
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
export function DotLoader({ label, color = "currentColor", size = 18, className }: DotLoaderProps) {
	const [{ Component, dotSize }] = useState(
		() => VARIANTS[Math.floor(Math.random() * VARIANTS.length)] as (typeof VARIANTS)[number],
	)

	// The wrapper, not the matrix, carries `className`: callers stack this in a grid cell or a
	// crossfade layer, and those classes have to land on the outermost node to have any effect.
	return (
		<span
			aria-hidden={label === undefined ? "true" : undefined}
			className={cn("inline-flex shrink-0 items-center justify-center", className)}
		>
			<Component size={size} dotSize={dotSize} color={color} ariaLabel={label ?? "Loading"} />
		</span>
	)
}
