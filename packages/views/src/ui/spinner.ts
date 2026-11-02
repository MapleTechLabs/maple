import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

// Port of packages/ui/src/components/ui/spinner.tsx: the loader glyph, spinning, as a status.

export const spinner = <M>(
	h: HtmlBuilder<M>,
	className?: string,
	size?: number,
	/** Leave it in the accessibility tree: the only loading cue in a menu that has no other status. */
	isAnnounced = false,
): Html =>
	icon(h, "LoaderIcon", {
		size,
		className: cn(spinnerStyles, className),
		attributes: [...(isAnnounced ? [] : [h.AriaHidden(true)]), h.AriaLabel("Loading"), h.Role("status")],
	})
