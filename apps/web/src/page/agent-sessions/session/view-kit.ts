import { cn } from "@maple/ui/lib/utils"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import type { Html, HtmlBuilder } from "foldkit/html"
import { badge } from "../../../ui/display"
import { icon } from "../../../ui/icon"

// Small pieces the session views share: the eyebrow section heading, the disclosure chevron and
// the failed badge.

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
