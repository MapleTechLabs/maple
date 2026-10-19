import { cn } from "@maple/ui/lib/utils"
import {
	sheetBackdropStyles,
	sheetCloseStyles,
	sheetDescriptionStyles,
	sheetHeaderStyles,
	sheetPopupLeftStyles,
	sheetPopupStyles,
	sheetTitleStyles,
	sheetViewportLeftStyles,
	sheetViewportStyles,
} from "@maple/ui/styles/ui/sheet"
import type { Attribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import { icon } from "./icon"

// `<Sheet><SheetPopup side="left">` (packages/ui/src/components/ui/sheet.tsx) over Base UI Dialog.

export type SheetOptions<Message> = Readonly<{
	id: string
	className?: string
	title: string
	description: string
	headerClassName?: string
	/** `data-slot` when a composition renders through the popup (`sidebar`). */
	slot?: string
	/** Extra popup attributes (`data-slot`, CSS variables) the caller's composition adds. */
	popupAttributes?: ReadonlyArray<Attribute<Message>>
	onDismiss: Message
}>

/** A left sheet: modal backdrops, the viewport and the dialog popup with its (hideable) close button. */
export const leftSheet = <Message>(
	h: HtmlBuilder<Message>,
	options: SheetOptions<Message>,
	children: ReadonlyArray<Html>,
): Html =>
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
					h.Class(cn(sheetViewportStyles, sheetViewportLeftStyles)),
					h.DataAttribute("open", ""),
					h.DataAttribute("slot", "sheet-viewport"),
					h.Role("presentation"),
				],
				[
					h.div(
						[
							h.AriaDescribedBy(`${options.id}-description`),
							h.AriaLabelledBy(`${options.id}-title`),
							h.Class(cn(sheetPopupStyles, sheetPopupLeftStyles, options.className)),
							h.DataAttribute("base-ui-focusable", ""),
							h.DataAttribute("open", ""),
							h.DataAttribute("slot", options.slot ?? "sheet-popup"),
							h.Id(options.id),
							h.Role("dialog"),
							h.Tabindex(-1),
							...(options.popupAttributes ?? []),
						],
						[
							h.div(
								[
									h.Class(cn(sheetHeaderStyles, options.headerClassName)),
									h.DataAttribute("slot", "sheet-header"),
								],
								[
									h.h2(
										[
											h.Class(cn(sheetTitleStyles)),
											h.DataAttribute("slot", "sheet-title"),
											h.Id(`${options.id}-title`),
										],
										[options.title],
									),
									h.p(
										[
											h.Class(cn(sheetDescriptionStyles)),
											h.DataAttribute("slot", "sheet-description"),
											h.Id(`${options.id}-description`),
										],
										[options.description],
									),
								],
							),
							...children,
							button(
								h,
								{
									size: "icon",
									variant: "ghost",
									className: sheetCloseStyles,
									attributes: [
										h.AriaLabel("Close"),
										h.Tabindex(0),
										h.OnClick(options.onDismiss),
									],
								},
								[icon(h, "XmarkIcon")],
							),
						],
					),
				],
			),
		],
	)
