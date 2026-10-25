import { button } from "@maple/web/ui/button"
import { empty, emptyContent, emptyDescription, emptyHeader, emptyMedia, emptyTitle } from "@maple/web/ui/empty"
import { icon } from "@maple/web/ui/icon"
import { skeletonList } from "@maple/web/ui/skeleton"
import type { Html, HtmlBuilder } from "foldkit/html"
import type { LoadFailure } from "../../data/local-query"

// Shared loading, empty and error placeholders.

export const emptyState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ icon?: Html; title: string; hint?: ReadonlyArray<Html | string>; action?: Html }>,
): Html =>
	empty(
		h,
		[
			...(options.icon === undefined ? [] : [emptyMedia(h, { variant: "icon" }, [options.icon])]),
			emptyHeader(h, [
				emptyTitle(h, [options.title]),
				...(options.hint === undefined ? [] : [emptyDescription(h, options.hint)]),
			]),
			...(options.action === undefined ? [] : [emptyContent(h, [options.action])]),
		],
		"h-full",
	)

/** `ErrorState`: "Couldn't load <label>", the failure text and Try again. */
export const errorState = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ label: string; failure: LoadFailure; onRetry?: M }>,
): Html =>
	empty(
		h,
		[
			emptyMedia(h, { variant: "icon" }, [icon(h, "CircleWarningIcon", { className: "text-destructive" })]),
			emptyHeader(h, [
				emptyTitle(h, ["Couldn’t load ", options.label]),
				emptyDescription(h, [options.failure.message], "font-mono text-xs break-all"),
			]),
			...(options.onRetry === undefined
				? []
				: [
						emptyContent(h, [
							button(h, { variant: "outline", size: "sm", attributes: [h.OnClick(options.onRetry)] }, [
								"Try again",
							]),
						]),
					]),
		],
		"h-full",
	)

/** `ListSkeleton`: `table` for row lists, `card` for card stacks, `grid` for the metrics grid. */
export const listSkeleton = <M>(
	h: HtmlBuilder<M>,
	options: Readonly<{ rows?: number; variant?: "table" | "card" | "grid" }> = {},
): Html => {
	const rows = options.rows ?? 8
	if (options.variant === "grid")
		return skeletonList(h, {
			rows,
			gap: "3",
			className: "m-4 grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3",
			rowClassName: "h-[124px] rounded-md",
		})
	return skeletonList(h, {
		rows,
		gap: "2",
		className: "p-4",
		rowClassName: options.variant === "card" ? "h-[68px] rounded-xl" : "h-10 rounded-md",
	})
}
