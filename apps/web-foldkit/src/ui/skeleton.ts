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
): Html =>
	h.div([
		h.Class(cn(skeletonStyles, className)),
		h.DataAttribute("slot", "skeleton"),
		...(style === undefined ? [] : [h.Style(style)]),
	])

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
