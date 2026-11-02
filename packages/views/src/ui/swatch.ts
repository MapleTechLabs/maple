import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"

/** The classes of a colour swatch, for an element the kit doesn't render. */
export const swatchClass = (options: { readonly dashed?: boolean; readonly className?: string } = {}): string =>
	cn("size-2 shrink-0 rounded-xs", options.dashed === true && "border border-dashed", options.className)

/** A small square colour key beside a legend, tooltip or table label; `dashed` draws an outline in `color`
 * instead of a fill. Without `color`, `className` colours it. */
export const swatch = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly color?: string
		readonly dashed?: boolean
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
