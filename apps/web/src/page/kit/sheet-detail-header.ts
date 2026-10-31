import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dialogDescription, dialogHeader, dialogTitle } from "../../ui/dialog-view"
import { detailEyebrow } from "./detail-header"

// `SheetDetailHeader`: a detail sheet's
// eyebrow kind, title, screen-reader description and meta row.

export type SheetDetailHeaderOptions = Readonly<{
	/** The sheet Dialog's id: the title and description are its `aria-labelledby`/`describedby`. */
	dialogId: string
	/** The eyebrow: one kind, or segments joined by a quiet dot. */
	kind?: string | ReadonlyArray<Html | string | null>
	title: ReadonlyArray<Html | string>
	/** Shown beside the title, e.g. a status badge. */
	adornment?: Html | null
	description: string
	meta?: ReadonlyArray<Html>
	mono?: boolean
	className?: string
}>

export const sheetDetailHeader = <M>(h: HtmlBuilder<M>, options: SheetDetailHeaderOptions): Html => {
	const isMono = options.mono ?? true
	const eyebrowNode =
		options.kind === undefined
			? null
			: detailEyebrow(h, typeof options.kind === "string" ? [options.kind] : options.kind)
	return dialogHeader(
		h,
		"sheet",
		[
			...(eyebrowNode === null ? [] : [eyebrowNode]),
			dialogTitle(
				h,
				"sheet",
				options.dialogId,
				[
					h.span([h.Class(cn("min-w-0", isMono ? "break-all" : "break-words"))], options.title),
					...(options.adornment === undefined || options.adornment === null
						? []
						: [options.adornment]),
				],
				cn("flex flex-wrap items-center gap-2 text-title leading-tight", isMono && "font-mono"),
			),
			dialogDescription(h, "sheet", options.dialogId, options.description, "sr-only"),
			...(options.meta === undefined || options.meta.length === 0
				? []
				: [h.div([h.Class("flex flex-wrap items-center gap-1.5")], options.meta)]),
		],
		cn("gap-1.5 pr-14", options.className),
	)
}
