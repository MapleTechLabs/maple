import { cn } from "@maple/ui/lib/utils"
import {
	skeletonListGapStyles,
	skeletonListRowDefaultStyles,
	skeletonListRowStyles,
	skeletonListStyles,
	skeletonStyles,
} from "@maple/ui/styles/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"

// Port of packages/ui/src/components/ui/skeleton.tsx.

export const skeleton = <M>(
	h: HtmlBuilder<M>,
	className?: string,
	/** Inline style the call site passes (`style={{ width }}`). */
	style?: Readonly<Record<string, string>>,
	/** `"span"` for a bar inside phrasing content (a text line, a stat value). */
	element: "div" | "span" = "div",
): Html => {
	const attributes = [
		h.Class(cn(skeletonStyles, className)),
		h.DataAttribute("slot", "skeleton"),
		...(style === undefined ? [] : [h.Style(style)]),
	]
	return element === "span" ? h.span(attributes) : h.div(attributes)
}

/** A muted line that appears once a skeleton has been up for 8s (`.skeleton-slow-note`), so a
 * stalled read stops reading as a normal load. It restarts whenever the skeleton remounts. */
export const skeletonSlowNote = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	h.p(
		[
			h.Class(cn("skeleton-slow-note text-muted-foreground text-xs", className)),
			h.DataAttribute("slot", "skeleton-slow-note"),
		],
		["Still loading. This is taking longer than usual."],
	)

export interface SkeletonListOptions {
	readonly rows?: number
	readonly rowClassName?: string
	readonly gap?: keyof typeof skeletonListGapStyles
	/** Accessible name for the loading region. */
	readonly label?: string
	readonly className?: string
	/** Custom row skeleton; receives the index for staggered widths. */
	readonly renderRow?: (index: number) => Html
}

/** A stack of identical skeleton rows: the loading state of a list or panel body. */
export const skeletonList = <M>(h: HtmlBuilder<M>, options: SkeletonListOptions = {}): Html =>
	h.div(
		[
			h.AriaBusy(true),
			...(options.label === undefined ? [] : [h.AriaLabel(options.label)]),
			h.Class(cn(skeletonListStyles, skeletonListGapStyles[options.gap ?? "px"], options.className)),
			h.DataAttribute("slot", "skeleton-list"),
		],
		Array.from({ length: options.rows ?? 4 }, (_, index) =>
			options.renderRow === undefined
				? skeleton(h, cn(skeletonListRowStyles, options.rowClassName ?? skeletonListRowDefaultStyles))
				: options.renderRow(index),
		),
	)

const BLOCK_HEIGHTS = {
	"16": "h-16",
	"24": "h-24",
	"32": "h-32",
	"40": "h-40",
	"44": "h-44",
	"48": "h-48",
} as const

/** A full-width rounded block of a fixed height: a card, chart or panel body while it loads. */
export const skeletonBlock = <M>(
	h: HtmlBuilder<M>,
	options: { readonly height: keyof typeof BLOCK_HEIGHTS; readonly className?: string },
): Html => skeleton(h, cn(BLOCK_HEIGHTS[options.height], "w-full rounded-md", options.className))

const METER_WIDTHS = { full: "w-full", half: "w-1/2" } as const

/** The classes of a meter track's ghost, for a bar the kit doesn't render. */
export const skeletonMeterClass = (width: keyof typeof METER_WIDTHS = "full"): string =>
	cn("h-1.5 rounded-full", METER_WIDTHS[width])

/** A thin rounded track while a meter or health bar loads. */
export const skeletonMeter = <M>(h: HtmlBuilder<M>, width: keyof typeof METER_WIDTHS = "full"): Html =>
	skeleton(h, skeletonMeterClass(width))

/** The classes of a switch's ghost, for a bar the kit doesn't render. */
export const skeletonSwitchClass = (): string => "h-5 w-9 rounded-full"

/** A switch-shaped pill while a toggle's state loads. */
export const skeletonSwitch = <M>(h: HtmlBuilder<M>): Html => skeleton(h, skeletonSwitchClass())

const LINE_WIDTHS = {
	"20": "w-20",
	"24": "w-24",
	"28": "w-28",
	"32": "w-32",
	"40": "w-40",
	"44": "w-44",
	"48": "w-48",
} as const

/** A short line of small text (`h-3`) while it loads; `visibleFrom` hides it below a breakpoint, as its column is. */
export const skeletonLine = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly width: keyof typeof LINE_WIDTHS
		readonly visibleFrom?: "md" | "lg"
		readonly className?: string
	},
): Html =>
	skeleton(
		h,
		cn(
			"h-3",
			LINE_WIDTHS[options.width],
			options.visibleFrom === "md" && "hidden md:block",
			options.visibleFrom === "lg" && "hidden lg:block",
			options.className,
		),
	)
