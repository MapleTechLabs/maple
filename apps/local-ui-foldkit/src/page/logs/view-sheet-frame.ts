import { cn } from "@maple/ui/lib/utils"
import {
	sheetBackdropStyles,
	sheetPopupRightStyles,
	sheetPopupStyles,
	sheetTitleStyles,
	sheetViewportRightStyles,
	sheetViewportStyles,
} from "@maple/ui/styles/ui/sheet"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"

// `<Sheet><SheetContent side="right" showCloseButton={false}>` over Base UI Dialog; the kit's
// `leftSheet` mirrored for the right side (the kit has no right sheet yet).

export type RightSheetOptions<M> = Readonly<{
	id: string
	className?: string
	/** `<SheetTitle className="sr-only">`'s children. */
	title: ReadonlyArray<Html | string>
	onDismiss: M
}>

export const rightSheet = <M>(h: HtmlBuilder<M>, options: RightSheetOptions<M>, children: ReadonlyArray<Html>): Html =>
	h.div(
		[h.DataAttribute("base-ui-portal", "")],
		[
			h.div(
				[
					h.AriaHidden(true),
					h.DataAttribute("base-ui-inert", ""),
					h.Role("presentation"),
					h.Style({ position: "fixed", inset: "0px", "user-select": "none" }),
				],
				[],
			),
			h.div(
				[
					h.AriaHidden(true),
					h.Class(cn(sheetBackdropStyles)),
					h.DataAttribute("base-ui-inert", ""),
					h.DataAttribute("open", ""),
					h.DataAttribute("slot", "sheet-backdrop"),
					h.Role("presentation"),
					h.Style({ "user-select": "none" }),
					h.OnClick(options.onDismiss),
				],
				[],
			),
			h.div(
				[
					h.Class(cn(sheetViewportStyles, sheetViewportRightStyles)),
					h.DataAttribute("open", ""),
					h.DataAttribute("slot", "sheet-viewport"),
					h.Role("presentation"),
				],
				[
					h.div(
						[
							h.AriaLabelledBy(`${options.id}-title`),
							h.Class(cn(sheetPopupStyles, sheetPopupRightStyles, options.className)),
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("open", ""),
							h.DataAttribute("slot", "sheet-popup"),
							h.Id(options.id),
							h.Role("dialog"),
							h.Tabindex(-1),
							h.OnKeyDownPreventDefault((key) => (key === "Escape" ? Option.some(options.onDismiss) : Option.none())),
						],
						[
							h.h2(
								[h.Class(cn(sheetTitleStyles, "sr-only")), h.DataAttribute("slot", "sheet-title"), h.Id(`${options.id}-title`)],
								options.title,
							),
							...children,
						],
					),
				],
			),
		],
	)
