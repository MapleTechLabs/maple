import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "@maple/views/ui/button"
import { listFooter } from "@maple/views/ui/list-footer"
import { hstack } from "@maple/views/ui/stack"

// `OffsetPager` and `pageRangeLabel`, on `ListFooter align="start"` with children only. Counts
// use `toLocaleString()` (en-US).

const count = (value: number) => value.toLocaleString("en-US")

/** "51-100 of 1,234 pods" for the toolbar of a page past the first. */
export const pageRangeLabel = (offset: number, shown: number, total: number, noun: string): string =>
	shown === 0
		? `0 of ${count(total)} ${noun}`
		: `${count(offset + 1)}-${count(offset + shown)} of ${count(total)} ${noun}`

export const offsetPager = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{
		offset: number
		shown: number
		total: number
		pageSize: number
		noun: string
		onPage: (direction: 1 | -1) => M
	}>,
): Html => {
	const hasPrevious = options.offset > 0
	const hasNext = options.offset + options.shown < options.total
	if (!hasPrevious && !hasNext) return null
	const page = Math.floor(options.offset / options.pageSize) + 1
	const pages = Math.max(1, Math.ceil(options.total / options.pageSize))
	return listFooter(h, {
		align: "start",
		className: "px-0 py-1",
		children: [
			h.span([], [pageRangeLabel(options.offset, options.shown, options.total, options.noun)]),
			hstack(h, { gap: "2", className: "ml-auto" },
				[
					h.span([], ["Page ", count(page), " of ", count(pages)]),
					button(
						h,
						{
							variant: "outline",
							size: "sm",
							isDisabled: !hasPrevious,
							attributes: [h.OnClick(options.onPage(-1))],
						},
						["Previous"],
					),
					button(
						h,
						{ variant: "outline", size: "sm", isDisabled: !hasNext, attributes: [h.OnClick(options.onPage(1))] },
						["Next"],
					),
				],
			),
		],
	})
}
