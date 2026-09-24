import { cn } from "@maple/ui/lib/utils"
import { Dotm3x3_6 } from "@/components/ui/dotm-3x3-6"

/**
 * Dot geometry: a 3×3 grid of 4px squares with a 1px gap, so the mark spans 14px — the same
 * box as the `size-3.5` check, cross and warning glyphs that replace it when the thing it
 * reports on settles, and the same box in every place it is used.
 *
 * It is one fixed size on purpose. The loader used to size itself per caller and roll one of
 * sixteen animations per mount, and both of those were mistakes at this scale: a 5×5 of 2px
 * dots and a 3×3 of 4px dots fill the same box with visibly different ink, and the sweeps in
 * that pool moved their lit region across the grid, so the mark's optical centre wandered
 * beside text that did not. Sixteen of those on a page, each drifting its own way, read as
 * sixteen different pieces of chrome.
 *
 * Both are passed explicitly because `size` alone does not survive the matrix: the 3×3 base
 * defaults `cellPadding` to 1, and any `cellPadding` makes the layout derive the span from the
 * dots and ignore `size` outright.
 */
const SPAN = 14
const DOT_SIZE = 4
const CELL_PADDING = 1

/**
 * The floor every dot rests at, overriding a default of 0.06 that let unlit dots disappear
 * completely. A loader whose off state is invisible reads as a blinking mark rather than a lit
 * grid with something moving across it, which at this size is the difference between a glyph
 * you can leave on screen for a whole turn and one you can't.
 */
const OPACITY_BASE = 0.2

/**
 * Core Echo's own pass at `speed` 1 — the matrix's 1500ms base loop times the 0.82 its rule
 * applies — and the pass we actually want. The matrix reads `speed` as a divisor of its own
 * loop, so handing it the ratio lands the animation on `TARGET_CYCLE_MS` exactly.
 */
const VARIANT_CYCLE_MS = 1230
const TARGET_CYCLE_MS = 1600

interface DotLoaderProps {
	/**
	 * Accessible name. Omit for the common case where adjacent text already says what is
	 * happening — the loader is then hidden from the accessibility tree rather than adding a
	 * second live region that announces the same thing.
	 */
	label?: string
	/** Ink. Defaults to `currentColor` so the loader takes the tone of the row it sits in. */
	color?: string
	className?: string
}

/**
 * The chat's "working" glyph: a dot matrix breathing out from its centre.
 *
 * Core Echo is the one animation in the dot-matrix family whose lit region is a ring around a
 * fixed centre, so the mark pulses in place instead of travelling — which is what lets it sit
 * beside streaming text for a whole turn without pulling the eye off the words.
 *
 * Nothing here re-enters React while a turn streams: the animation is CSS on static dots, and
 * `prefers-reduced-motion` is handled inside the matrix, which paints a single resting frame
 * instead of starting a loop.
 */
export function DotLoader({ label, color = "currentColor", className }: DotLoaderProps) {
	// The wrapper, not the matrix, carries `className`: callers stack this in a grid cell or a
	// crossfade layer, and those classes have to land on the outermost node to have any effect.
	return (
		<span
			aria-hidden={label === undefined ? "true" : undefined}
			className={cn("inline-flex shrink-0 items-center justify-center", className)}
		>
			<Dotm3x3_6
				size={SPAN}
				dotSize={DOT_SIZE}
				cellPadding={CELL_PADDING}
				opacityBase={OPACITY_BASE}
				speed={VARIANT_CYCLE_MS / TARGET_CYCLE_MS}
				// Square dots, not circles: this is a pixel grid, which is the language the rest of
				// Maple's small marks are drawn in.
				dotMark="square"
				color={color}
				ariaLabel={label ?? "Loading"}
			/>
		</span>
	)
}
