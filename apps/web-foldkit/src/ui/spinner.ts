import { cn } from "@maple/ui/lib/utils"
import { spinnerStyles } from "@maple/ui/styles/ui/spinner"
import type { Html, HtmlBuilder } from "foldkit/html"
import { loaderIcon } from "./icons"

// Port of packages/ui/src/components/ui/spinner.tsx: the loader glyph, spinning, as a status.

export const spinner = <M>(h: HtmlBuilder<M>, className?: string): Html =>
	loaderIcon(h, cn(spinnerStyles, className), [
		h.AriaHidden(true),
		h.AriaLabel("Loading"),
		h.Role("status"),
	])
