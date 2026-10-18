import { cn } from "@maple/ui/lib/utils"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { eyebrow } from "../../../ui/eyebrow"
import { icon } from "../../../ui/icon"

// Small pieces the session views share: `SectionHeading variant="eyebrow"`, `DisclosureChevron`,
// `FailedBadge` (session-waterfall.tsx).

/** `SectionHeading variant="eyebrow"`; `actions` sit at the row's right edge. */
export const eyebrowHeading = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ title: string; className?: string; actions?: Html }>,
): Html => {
	const heading = eyebrow(
		h,
		{ as: "h3", className: cn("mb-3 block", options.actions === undefined ? options.className : "mb-0") },
		[options.title],
	)
	return options.actions === undefined
		? heading
		: h.div(
				[
					h.Class(
						cn("flex flex-wrap items-center justify-between gap-x-3 gap-y-2", options.className),
					),
				],
				[heading, options.actions],
			)
}

/** `DisclosureChevron`: `right` turns down when open, `down` flips up. */
export const disclosureChevron = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isOpen: boolean; direction?: "right" | "down"; size?: number; className?: string }>,
): Html => {
	const direction = options.direction ?? "right"
	return icon(h, direction === "right" ? "ChevronRightIcon" : "ChevronDownIcon", {
		size: options.size,
		className: cn(
			"shrink-0 transition-transform",
			options.isOpen && (direction === "right" ? "rotate-90" : "rotate-180"),
			options.className,
		),
		attributes: [h.AriaHidden(true)],
	})
}

/** `FailedBadge`. */
export const failedBadge = <M>(h: HtmlBuilder<M>, label: string = "Failed"): Html =>
	badge(h, { variant: "tag", className: TONE_SOFT.crit }, [label])
