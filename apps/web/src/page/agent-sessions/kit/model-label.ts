import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, iconColor } from "../../../ui/icon"
import { type DetectedModel, modelTitle } from "./detected-models"
import { modelVendorColor, modelVendorIcon } from "./vendor"

/** The vendor's mark and the model's name. */
export const modelLabel = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		detected: DetectedModel
		moreCount?: number
		size?: number
		/** `null` leaves the title off, for a caller that names the model in a tooltip. */
		title?: string | null
		className?: string
	}>,
): Html => {
	const title = options.title === undefined ? modelTitle(options.detected) : options.title
	const color = modelVendorColor(options.detected)
	const moreCount = options.moreCount ?? 0
	return h.span(
		[
			h.Class(cn("flex min-w-0 items-center gap-1.5", options.className)),
			...(title === null ? [] : [h.Title(title)]),
		],
		[
			icon(h, modelVendorIcon(options.detected), {
				size: options.size ?? 13,
				className: "shrink-0",
				...iconColor(color),
				attributes: [h.AriaHidden(true)],
			}),
			h.span([h.Class("min-w-0 truncate")], [options.detected.displayName]),
			...(moreCount > 0 ? [h.span([h.Class("shrink-0 tabular-nums")], ["+", String(moreCount)])] : []),
		],
	)
}
