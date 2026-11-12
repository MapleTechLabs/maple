import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

const swatchClass = (
	options: { readonly dashed?: boolean; readonly round?: boolean; readonly className?: string } = {},
): string =>
	cn(
		"size-2 shrink-0",
		options.round === true ? "rounded-full" : "rounded-xs",
		options.dashed === true && "border border-dashed",
		options.className,
	)

/** A small square colour key beside a legend, tooltip or table label; `dashed` draws an outline in `color`
 * instead of a fill, `round` a dot for a series that is a share, not a line. Without `color`, `className`
 * colours it. */
export const swatch = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly color?: string
		readonly dashed?: boolean
		readonly round?: boolean
		readonly ariaHidden?: boolean
		readonly className?: string
	} = {},
): Html =>
	h.span([
		...(options.ariaHidden === true ? [h.AriaHidden(true)] : []),
		h.Class(swatchClass(options)),
		...(options.color === undefined
			? []
			: [
					h.Style(
						options.dashed === true
							? { "border-color": options.color }
							: { "background-color": options.color },
					),
				]),
	])
