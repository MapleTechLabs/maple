import { cn } from "@maple/ui/lib/utils"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"

/** The classes of a layer, for an element the kit doesn't render. */
export const layerClass = (options: { readonly clip?: boolean; readonly className?: string } = {}): string =>
	cn("pointer-events-none absolute inset-0", options.clip === true && "overflow-hidden", options.className)

/** A layer stretched over its positioned parent that lets the pointer through (a vignette, a backdrop
 * canvas, a chart overlay); `clip` cuts what overflows it. */
export const layer = <M>(
	h: HtmlBuilder<M>,
	options: {
		readonly clip?: boolean
		readonly className?: string
		readonly attributes?: ReadonlyArray<Attribute<M>>
	},
	children: ReadonlyArray<Html | string>,
): Html => h.div([h.Class(layerClass(options)), ...(options.attributes ?? [])], children)
