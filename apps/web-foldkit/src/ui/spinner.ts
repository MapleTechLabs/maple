import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "./icon"

// Port of packages/ui/src/components/ui/spinner.tsx: the loader glyph, spinning, as a status.

export const spinner = <M>(h: HtmlBuilder<M>, className?: string, size?: number): Html =>
	icon(h, "LoaderIcon", {
		size,
		className: cn(spinnerStyles, className),
		attributes: [h.AriaHidden(true), h.AriaLabel("Loading"), h.Role("status")],
	})
