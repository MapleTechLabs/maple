import { cn } from "../../lib/utils"

/**
 * `Button` dims unstyled child SVGs to 80% (its `[&_svg:not([class*='opacity-'])]`
 * rule). That's right for the resting glyph and wrong for the success/failure
 * ones — those carry semantic color and should land at full strength. Any class
 * matching `opacity-` opts out.
 */
export const copyIndicatorFullStrengthStyles = "opacity-100"

/**
 * All three glyph layers stay mounted and the active one is picked purely in
 * CSS, off a `data-copy-status` attribute on the nearest `group/copy`. This is a
 * per-row affordance on detail surfaces — one per expanded JSON blob, per log
 * attribute chip, per key row — and it sits idle essentially all the time, so it
 * deliberately costs nothing per instance: no animation library, no
 * `prefers-reduced-motion` subscription, no work at all until the status flips.
 *
 * The timings are what the springs used to land on. The old crossfade spring was
 * overdamped (ζ≈1.18), which reads as a decel curve, so it maps onto a 240ms
 * ease-out; the draw keeps its original 260ms.
 */
export const copyEaseStyles = "ease-[cubic-bezier(0.23,1,0.32,1)] motion-reduce:transition-none"

/** One grid cell, faded and scaled back until its status is the active one. */
export const copyIndicatorLayerStyles = cn(
	"col-start-1 row-start-1 flex items-center justify-center",
	"scale-[0.92] opacity-0 transition-[opacity,scale] duration-[240ms]",
	copyEaseStyles,
)

/** Mirrors `CopyStatus` in `hooks/use-copy`, kept here so this module stays React-free. */
export type CopyIndicatorStatus = "copied" | "error" | "idle"

/**
 * Spelled out per status rather than interpolated — Tailwind only emits classes
 * that appear literally in the source.
 */
export const copyIndicatorLayerActiveStyles: Record<CopyIndicatorStatus, string> = {
	copied: "group-data-[copy-status=copied]/copy:scale-100 group-data-[copy-status=copied]/copy:opacity-100",
	error: "group-data-[copy-status=error]/copy:scale-100 group-data-[copy-status=error]/copy:opacity-100",
	idle: "group-data-[copy-status=idle]/copy:scale-100 group-data-[copy-status=idle]/copy:opacity-100",
} satisfies Record<CopyIndicatorStatus, string>

/**
 * `pathLength="1"` renormalises the check to a unit length, so the dash pair is
 * a literal `1` rather than a measured one and the draw is a plain
 * `stroke-dashoffset: 1 → 0` — no JS ever touches the path.
 */
export const copyIndicatorCheckDrawStyles = cn(
	"[stroke-dasharray:1] [stroke-dashoffset:1] transition-[stroke-dashoffset] duration-[260ms]",
	"group-data-[copy-status=copied]/copy:[stroke-dashoffset:0]",
	copyEaseStyles,
)

/** Same crossfade as the glyph, plus the blur/rise the label has always had. */
export const copyLabelLayerStyles = cn(
	"col-start-1 row-start-1 whitespace-nowrap",
	"translate-y-[3px] opacity-0 blur-[3px] transition-[opacity,filter,translate] duration-[240ms]",
	copyEaseStyles,
)

export const copyLabelActiveStyles: Record<CopyIndicatorStatus, string> = {
	copied: "group-data-[copy-status=copied]/copy:translate-y-0 group-data-[copy-status=copied]/copy:opacity-100 group-data-[copy-status=copied]/copy:blur-[0px]",
	error: "group-data-[copy-status=error]/copy:translate-y-0 group-data-[copy-status=error]/copy:opacity-100 group-data-[copy-status=error]/copy:blur-[0px]",
	idle: "group-data-[copy-status=idle]/copy:translate-y-0 group-data-[copy-status=idle]/copy:opacity-100 group-data-[copy-status=idle]/copy:blur-[0px]",
} satisfies Record<CopyIndicatorStatus, string>

export const copyIndicatorStyles = "group/copy grid shrink-0"

export const copyIndicatorCopiedStyles = "text-severity-info"

export const copyIndicatorErrorStyles = "text-destructive-foreground"

export const copyLabelStyles = "relative grid"

export const copyButtonStyles =
	"group/copy text-muted-foreground hover:text-foreground active:text-foreground"

export const copyButtonStatusStyles = "sr-only"
