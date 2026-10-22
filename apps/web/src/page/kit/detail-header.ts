import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { eyebrow } from "../../ui/eyebrow"
import { pageTitle } from "../../ui/page-layout"
import { skeleton } from "../../ui/skeleton"

// `DetailHeader`'s title side and `DetailHeaderSkeleton`.
// The page passes the result as `dashboardPage`'s `titleContent`, its actions as `actions`.

type Children = ReadonlyArray<Html | string>

/** `DetailEyebrow`: the kind segments joined by a quiet dot. */
export const detailEyebrow = <M>(
	h: HtmlBuilder<M>,
	segments: ReadonlyArray<Html | string | null>,
	className?: string,
): Html | null => {
	const shown = segments.filter((segment): segment is Html | string => segment !== null && segment !== "")
	return shown.length === 0
		? null
		: eyebrow(
				h,
				{ as: "div", className: cn("flex flex-wrap items-center gap-x-2 gap-y-1", className) },
				shown.flatMap((segment, index) => [
					...(index > 0
						? [h.span([h.AriaHidden(true), h.Class("text-muted-foreground/40")], ["·"])]
						: []),
					h.span([h.Class("truncate")], [segment]),
				]),
			)
}

export type DetailTitleOptions = Readonly<{
	kind?: ReadonlyArray<Html | string | null>
	title: Children
	/** The truncating title's tooltip (`titleText`, or the title when it is a string). */
	titleText?: string
	adornment?: Html
	meta?: Children
}>

export const detailTitle = <M>(h: HtmlBuilder<M>, options: DetailTitleOptions): Html => {
	const eyebrowNode = options.kind === undefined ? null : detailEyebrow(h, options.kind)
	const tooltip =
		options.titleText ??
		(options.title.length === 1 && typeof options.title[0] === "string" ? options.title[0] : undefined)
	return h.div(
		[h.Class("min-w-0 space-y-2.5")],
		[
			...(eyebrowNode === null ? [] : [eyebrowNode]),
			pageTitle(
				h,
				{
					title: tooltip,
					className: options.adornment === undefined ? undefined : "flex items-center gap-2.5",
				},
				options.adornment === undefined
					? options.title
					: [h.span([h.Class("truncate")], options.title), options.adornment],
			),
			...(options.meta === undefined || options.meta.length === 0
				? []
				: [h.div([h.Class("flex flex-wrap items-center gap-2")], options.meta)]),
		],
	)
}

/** `DetailHeaderSkeleton`'s title side. */
export const detailTitleSkeleton = <M>(h: HtmlBuilder<M>, hasMeta = true): Html =>
	h.div(
		[h.Class("min-w-0 space-y-2.5"), h.AriaBusy(true)],
		[skeleton(h, "h-3 w-32"), skeleton(h, "h-7 w-3/4"), ...(hasMeta ? [skeleton(h, "h-5 w-48")] : [])],
	)

/** `DetailHeader`'s actions wrapper. */
export const detailActions = <M>(h: HtmlBuilder<M>, children: Children): Html =>
	h.div([h.Class("flex items-center gap-2")], children)
