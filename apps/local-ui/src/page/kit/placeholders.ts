import {
	empty,
	emptyContent,
	emptyDescription,
	emptyHeader,
	emptyMedia,
	emptyTitle,
} from "@maple/views/ui/empty"
import { skeletonList } from "@maple/views/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"

/** A page body's "nothing here" block from the kit's `empty` parts, filling its area. */
export const emptyNotice = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ icon?: Html; title: string; hint: string; action?: Html }>,
): Html =>
	empty(
		h,
		[
			...(options.icon === undefined ? [] : [emptyMedia(h, { variant: "icon" }, [options.icon])]),
			emptyHeader(h, [emptyTitle(h, [options.title]), emptyDescription(h, [options.hint])]),
			...(options.action === undefined ? [] : [emptyContent(h, [options.action])]),
		],
		"h-full",
	)

/** A loading list: 40px rows for a table, 68px rounded cards for a card stack. */
export const listSkeleton = <M>(h: HtmlBuilder<M>, variant: "table" | "card", rows: number): Html =>
	skeletonList(h, {
		rows,
		gap: "2",
		className: "p-4",
		rowClassName: variant === "card" ? "h-[68px] rounded-xl" : "h-10 rounded-md",
	})
