import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon, iconColor } from "@maple/views/ui/icon"
import { type DetectedModel, modelTitle } from "./detected-models"
import { modelVendorColor, modelVendorIcon } from "./vendor"
import { moreChip } from "./more-chip"
import { hstackClass } from "@maple/views/ui/stack"
import { typography } from "@maple/views/ui/typography"

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
			h.Class(cn(hstackClass({ gap: "1.5", shrink: true }), options.className)),
			...(title === null ? [] : [h.Title(title)]),
		],
		[
			icon(h, modelVendorIcon(options.detected), {
				size: options.size ?? 13,
				className: "shrink-0",
				...iconColor(color),
				attributes: [h.AriaHidden(true)],
			}),
			typography(h, { truncate: true, className: "min-w-0" }, [options.detected.displayName]),
			...(moreCount > 0 ? [moreChip(h, { count: moreCount })] : []),
		],
	)
}
