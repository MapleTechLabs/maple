import { cn } from "@maple/ui/lib/utils"
import { filterSidebarFrame } from "@maple/views/ui/filters/filter-sidebar"
import type { Html, HtmlBuilder } from "foldkit/html"

/**
 * `filterRailFrame`: a page's filter rail at Maple Local's fixed rail width and inset, over the
 * shared `filterSidebarFrame` (which dims while `isWaiting`).
 */
export const filterRailFrame = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ isWaiting?: boolean; className?: string }>,
	children: ReadonlyArray<Html>,
): Html =>
	filterSidebarFrame(
		h,
		{ className: cn("w-56 shrink-0 px-4", options.className), isWaiting: options.isWaiting ?? false },
		children,
	)
