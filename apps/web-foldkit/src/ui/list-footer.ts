import { cn } from "@maple/ui/lib/utils"
import {
	listFooterCenterStyles,
	listFooterStartStyles,
	listFooterStyles,
} from "@maple/ui/styles/ui/list-footer"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"

// Port of `ListFooter` and `LoadMoreButton` (packages/ui/src/components/ui/list-footer.tsx).
// The count reads `toLocaleString()` there; the app is en-US, so it is formatted en-US here.

export type ListFooterOptions<M> = Readonly<{
	shown?: number
	total?: number
	noun?: string
	singular?: string
	hasMore?: boolean
	isLoading?: boolean
	isFailed?: boolean
	isCapped?: boolean
	onLoadMore?: M
	align?: "start" | "center"
	className?: string
}>

const count = (value: number) => value.toLocaleString("en-US")

const countText = <M>(options: ListFooterOptions<M>): string | null => {
	const { shown, total, noun } = options
	if (shown === undefined || noun === undefined || noun === "") return null
	const one = options.singular ?? (/[^s]s$/.test(noun) && !noun.endsWith("ies") ? noun.slice(0, -1) : noun)
	const nounFor = (n: number) => (n === 1 ? one : noun)
	if (total !== undefined && total > shown)
		return `Showing ${count(shown)} of ${count(total)} ${nounFor(total)}`
	if (options.isCapped === true)
		return `Showing first ${count(shown)} ${nounFor(shown)}, narrow the filters to see more`
	if (options.hasMore === true) return `Showing ${count(shown)} ${nounFor(shown)}, more available`
	return `${count(shown)} ${nounFor(shown)}`
}

/** The footer under a paged list: how much is shown, and the button for more. */
export const listFooter = <M>(h: HtmlBuilder<M>, options: ListFooterOptions<M>): Html | null => {
	const text = countText(options)
	const canLoad =
		options.onLoadMore !== undefined && (options.hasMore === true || options.isFailed === true)
	if (text === null && !canLoad) return null
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
		[
			...(text === null ? [] : [h.span([], [text])]),
			...(canLoad && options.onLoadMore !== undefined
				? [
						button(
							h,
							{
								variant: "outline",
								size: "sm",
								isLoading: options.isLoading ?? false,
								attributes: [h.OnClick(options.onLoadMore)],
							},
							[options.isFailed === true ? "Retry" : "Load more"],
						),
					]
				: []),
		],
	)
}
