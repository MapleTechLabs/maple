import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { icon } from "@maple/views/ui/icon"

/** The chevron at the start of a row that opens in place: right when closed, down when open. */
export const expandChevron = <M>(h: HtmlBuilder<M>, isExpanded: boolean): Html =>
	icon(h, "ChevronRightIcon", {
		size: 12,
		className: cn("text-foreground-subtle shrink-0 transition-transform", isExpanded && "rotate-90"),
	})
