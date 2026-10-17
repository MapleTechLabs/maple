import { cn } from "@maple/ui/lib/utils"
import {
	listFooterCenterStyles,
	listFooterStartStyles,
	listFooterStyles,
	loadingMoreRowSpinnerStyles,
	loadingMoreRowStyles,
} from "@maple/ui/styles/ui/list-footer"
import type { Html, HtmlBuilder } from "foldkit/html"
import { spinner } from "./spinner"

// Port of `ListFooter` and `LoadingMoreRow` (packages/ui/src/components/ui/list-footer.tsx).
// TODO(load-more): the "Load more" / "Retry" button is not ported (no caller passes `onLoadMore` yet).

export type ListFooterOptions = Readonly<{
	shown?: number
	total?: number
	noun?: string
	singular?: string
	hasMore?: boolean
	capped?: boolean
	align?: "start" | "center"
	className?: string
}>

const countCopy = (options: ListFooterOptions): string | null => {
	const { shown, noun } = options
	if (shown === undefined || noun === undefined || noun === "") return null
	const one = options.singular ?? (/[^s]s$/.test(noun) && !noun.endsWith("ies") ? noun.slice(0, -1) : noun)
	const nounFor = (n: number) => (n === 1 ? one : noun)
	const total = options.total
	if (total !== undefined && total > shown)
		return `Showing ${shown.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${nounFor(total)}`
	if (options.capped === true)
		return `Showing first ${shown.toLocaleString("en-US")} ${nounFor(shown)}, narrow the filters to see more`
	if (options.hasMore === true)
		return `Showing ${shown.toLocaleString("en-US")} ${nounFor(shown)}, more available`
	return `${shown.toLocaleString("en-US")} ${nounFor(shown)}`
}

export const listFooter = <M>(
	h: HtmlBuilder<M>,
	options: ListFooterOptions,
	children: ReadonlyArray<Html> = [],
): Html | null => {
	const count = countCopy(options)
	if (count === null && children.length === 0) return null
	return h.div(
		[
			h.Class(
				cn(
					listFooterStyles,
					(options.align ?? "center") === "center" ? listFooterCenterStyles : listFooterStartStyles,
					options.className,
				),
			),
			h.DataAttribute("slot", "list-footer"),
		],
		[...(count === null ? [] : [h.span([], [count])]), ...children],
	)
}

/** In-table "Loading more…" row for infinite lists. */
export const loadingMoreRow = <M>(h: HtmlBuilder<M>, label = "Loading more…"): Html =>
	h.div([h.Class(loadingMoreRowStyles), h.Role("status")], [spinner(h, loadingMoreRowSpinnerStyles), label])
