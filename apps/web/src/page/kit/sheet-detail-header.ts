import { cn } from "@maple/ui/lib/utils"
import type { Html, HtmlBuilder } from "foldkit/html"
import { dialogDescription, dialogHeader, dialogTitle } from "../../ui/dialog-view"
import { eyebrow } from "../../ui/eyebrow"

// `SheetDetailHeader`: a detail sheet's
// eyebrow kind, title, screen-reader description and meta row.

export type SheetDetailHeaderOptions = Readonly<{
	/** The sheet Dialog's id: the title and description are its `aria-labelledby`/`describedby`. */
	dialogId: string
	kind?: string
	title: ReadonlyArray<Html | string>
	description: string
	meta?: ReadonlyArray<Html>
	mono?: boolean
	className?: string
}>

export const sheetDetailHeader = <M>(h: HtmlBuilder<M>, options: SheetDetailHeaderOptions): Html => {
	const isMono = options.mono ?? true
	return dialogHeader(
		h,
		"sheet",
		[
			...(options.kind === undefined
				? []
				: [
						eyebrow(h, { as: "div", className: "flex flex-wrap items-center gap-x-2 gap-y-1" }, [
							h.span([h.Class("truncate")], [options.kind]),
						]),
					]),
			dialogTitle(
				h,
				"sheet",
				options.dialogId,
				[h.span([h.Class(cn("min-w-0", isMono ? "break-all" : "break-words"))], options.title)],
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
