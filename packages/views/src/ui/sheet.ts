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
	type SheetSize,
} from "./sheet.styles"
import { Command } from "foldkit"
import type { Attribute, ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import * as Dialog from "./dialog"
import * as DialogView from "./dialog-view"
import { icon } from "./icon"

// A left-side sheet over Base UI Dialog.

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
											h.Class(cn(sheetTitleStyles, "font-display tracking-tight")),
											h.DataAttribute("slot", "sheet-title"),
											h.Id(`${options.id}-title`),
										],
										[options.title],
									),
									h.p(
										[
											h.Class(cn(sheetDescriptionStyles, "font-prose")),
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

// SIDE PANEL SHEET

/**
 * How wide a side panel is, by what it holds: `compact` (28rem) a short form of a few fields,
 * `form` (42rem) a full create or edit form, `wide` (48rem) reading content.
 */
export type SidePanelSize = "compact" | "form" | "wide"

const SIDE_PANEL_SIZE = {
	compact: "default",
	form: "form",
	wide: "wide",
} satisfies Record<SidePanelSize, SheetSize>

export type SidePanelSheetOptions<Message> = Readonly<{
	sheet: Dialog.Model
	title: string
	description?: string
	/** `form` by default; pick `compact` when the form is a handful of short fields. */
	size?: SidePanelSize
	/** The scrolling body. */
	body: ReadonlyArray<Html>
	/**
	 * The sticky footer (Cancel, then the primary action), handed the close button's attributes so
	 * Cancel dismisses like Escape does; none renders no footer.
	 */
	footer?: (close: ReadonlyArray<ChildAttribute>) => ReadonlyArray<Html>
	toParentMessage: (message: Dialog.Message) => Message
}>

// Reduced motion keeps the fade and drops the slide.
const REDUCED_MOTION =
	"motion-reduce:data-ending-style:translate-x-0 motion-reduce:data-starting-style:translate-x-0"

/**
 * A full-height panel from the right over the Dialog Submodel: title, close, a scrolling body and a
 * sticky footer. Its dim is light and unblurred, so the page it belongs to stays readable. Escape,
 * the backdrop and the close button close it (`isDismissed`).
 */
export const sidePanelSheet = <Message>(
	h: HtmlBuilder<Message>,
	options: SidePanelSheetOptions<Message>,
): Html => {
	const { sheet } = options
	return h.submodel({
		slotId: `${sheet.id}-sheet`,
		model: sheet,
		view: DialogView.view,
		viewInputs: {
			side: "right",
			size: SIDE_PANEL_SIZE[options.size ?? "form"],
			scrim: "panel",
			className: REDUCED_MOTION,
			hasDescription: options.description !== undefined,
			toView: ({ portal }) => portal,
			toContent: (close) => [
				DialogView.dialogHeader(h, "sheet", [
					DialogView.dialogTitle(h, "sheet", sheet.id, options.title),
					...(options.description === undefined
						? []
						: [DialogView.dialogDescription(h, "sheet", sheet.id, options.description)]),
				]),
				DialogView.dialogPanel(h, "sheet", sheet.id, options.body),
				...(options.footer === undefined
					? []
					: [DialogView.dialogFooter(h, "sheet", options.footer(close))]),
			],
		},
		toParentMessage: options.toParentMessage,
	})
}

export type SheetStep = ReturnType<typeof Dialog.update>

/**
 * A sheet whose open state lives in the URL: open or close it to match. The Opened/Closed it
 * reports are dropped, as the URL already says so.
 */
export const followUrl = (sheet: Dialog.Model, isOpenInUrl: boolean): SheetStep => {
	const step = isOpenInUrl ? Dialog.open(sheet) : Dialog.close(sheet)
	return { model: step.model, commands: step.commands }
}

/** The sheet closed itself (Escape, backdrop, close button): the caller clears its URL state. */
export const isDismissed = (step: SheetStep): boolean => step.outMessage?._tag === "Closed"

/** A sheet step's commands under the parent's Message. */
export const mapSheetCommands = <Message>(
	step: SheetStep,
	toParentMessage: (message: Dialog.Message) => Message,
) => Command.mapMessages(step.commands ?? [], toParentMessage)
