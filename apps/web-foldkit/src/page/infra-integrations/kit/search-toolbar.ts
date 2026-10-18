import { countLabel as nounCount } from "@maple/ui/lib/format"
import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { searchInput } from "../../../ui/search-input"

// `SearchToolbar` and `countLabel` (apps/web/src/components/common/search-toolbar.tsx).

export type SearchToolbarOptions<M> = Readonly<{
	id: string
	value: string
	placeholder: string
	onInput: (value: string) => M
	onClear: M
	/** Controls beside the search: a kind pivot, a sort menu. */
	children?: ReadonlyArray<Html>
	trailing?: string
	className?: string
}>

export const searchToolbar = <M>(h: HtmlBuilder<M>, options: SearchToolbarOptions<M>): Html =>
	h.div(
		[h.Class(cn("flex flex-wrap items-center justify-between gap-3", options.className))],
		[
			h.div(
				[h.Class("flex flex-wrap items-center gap-2")],
				[
					searchInput(h, {
						id: options.id,
						size: "default",
						className: "w-64",
						placeholder: options.placeholder,
						value: options.value,
						onInput: options.onInput,
						onClear: options.onClear,
					}),
					...(options.children ?? []),
				],
			),
			...(options.trailing === undefined || options.trailing === ""
				? []
				: [h.span([h.Class("text-xs text-muted-foreground tabular-nums")], [options.trailing])]),
		],
	)

/** "Top 50 of 541 pods" for a slice, "541 pods" for the whole list. */
export const countLabel = (shown: number, total: number, noun: string): string => {
	const counted = nounCount(total, noun)
	return total > shown ? `Top ${shown} of ${counted}` : counted
}
