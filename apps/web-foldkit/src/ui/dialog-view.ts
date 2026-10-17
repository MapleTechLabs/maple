import { cn } from "@maple/ui/lib/utils"
import * as AlertDialogStyles from "@maple/ui/styles/ui/alert-dialog"
import { buttonVariants } from "@maple/ui/styles/ui/button"
import * as CommandStyles from "@maple/ui/styles/ui/command"
import * as DialogStyles from "@maple/ui/styles/ui/dialog"
import * as SheetStyles from "@maple/ui/styles/ui/sheet"
import { Option } from "effect"
import { Submodel } from "foldkit"
import { type ChildAttribute, childAttributes, type Html, type HtmlBuilder } from "foldkit/html"
import {
	descriptionId,
	type Kind,
	Message,
	type Model,
	MountDialog,
	popupId,
	titleId,
	triggerId,
} from "./dialog"
import { xmarkIcon } from "./overlay/icons"
import { scrollArea } from "./scroll-area"
import { focusGuard, isMounted, stateAttributes } from "./overlay/transition"

export type SheetSide = "right" | "left" | "top" | "bottom"

type Parts = Readonly<{
	backdrop: string
	viewport: string
	popup: string
	closeButton: Option.Option<string>
	role: "dialog" | "alertdialog"
	isLabelled: boolean
}>

// dialog.tsx `DialogPopup`, alert-dialog.tsx `AlertDialogPopup`, sheet.tsx `SheetPopup`, command.tsx
const partsOf = (kind: Kind, side: SheetSide, className: string | undefined): Parts => {
	switch (kind) {
		case "dialog":
			return {
				backdrop: cn(DialogStyles.dialogBackdropStyles),
				viewport: cn(DialogStyles.dialogViewportStyles, DialogStyles.dialogViewportBottomStickStyles),
				popup: cn(
					DialogStyles.dialogPopupStyles,
					DialogStyles.dialogPopupBottomStickStyles,
					className,
				),
				closeButton: Option.some(DialogStyles.dialogCloseStyles),
				role: "dialog",
				isLabelled: true,
			}
		case "alert-dialog":
			return {
				backdrop: cn(AlertDialogStyles.alertDialogBackdropStyles),
				viewport: cn(
					AlertDialogStyles.alertDialogViewportStyles,
					AlertDialogStyles.alertDialogViewportBottomStickStyles,
				),
				popup: cn(
					AlertDialogStyles.alertDialogPopupStyles,
					AlertDialogStyles.alertDialogPopupBottomStickStyles,
					className,
				),
				closeButton: Option.none(),
				role: "alertdialog",
				isLabelled: true,
			}
		case "sheet":
			return {
				backdrop: cn(SheetStyles.sheetBackdropStyles),
				viewport: cn(
					SheetStyles.sheetViewportStyles,
					side === "bottom" && SheetStyles.sheetViewportBottomStyles,
					side === "top" && SheetStyles.sheetViewportTopStyles,
					side === "left" && SheetStyles.sheetViewportLeftStyles,
					side === "right" && SheetStyles.sheetViewportRightStyles,
				),
				popup: cn(
					SheetStyles.sheetPopupStyles,
					side === "bottom" && SheetStyles.sheetPopupBottomStyles,
					side === "top" && SheetStyles.sheetPopupTopStyles,
					side === "left" && SheetStyles.sheetPopupLeftStyles,
					side === "right" && SheetStyles.sheetPopupRightStyles,
					className,
				),
				closeButton: Option.some(SheetStyles.sheetCloseStyles),
				role: "dialog",
				isLabelled: true,
			}
		case "command-dialog":
			return {
				backdrop: cn(CommandStyles.commandDialogBackdropStyles),
				viewport: cn(CommandStyles.commandDialogViewportStyles),
				popup: cn(CommandStyles.commandDialogPopupStyles, className),
				closeButton: Option.none(),
				role: "dialog",
				isLabelled: false,
			}
	}
}

/**
 * What the parent places: `trigger` attributes for its own button (absent for a dialog opened
 * from code) and the `portal`, which its Mount moves to `<body>`.
 */
export type RenderInfo = Readonly<{ trigger: ReadonlyArray<ChildAttribute>; portal: Html }>

export type ViewInputs = Readonly<{
	toView: (render: RenderInfo) => Html
	/** The popup's content; spread `close` on the content's Close buttons. */
	toContent: (close: ReadonlyArray<ChildAttribute>) => ReadonlyArray<Html>
	className?: string
	side?: SheetSide
	hasTrigger?: boolean
}>

const slotPrefix = (kind: Kind) => kind

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const parts = partsOf(model.kind, inputs.side ?? "right", inputs.className)
	const slot = slotPrefix(model.kind)
	const isVisible = isMounted(model.isOpen, model.animation)
	const state = stateAttributes(h, model.isOpen, model.animation)
	const trigger = childAttributes([
		...(isVisible ? [h.AriaControls(popupId(model.id))] : []),
		h.AriaExpanded(model.isOpen),
		h.AriaHasPopup("dialog"),
		h.DataAttribute("base-ui-click-trigger", ""),
		...(model.isOpen ? [h.DataAttribute("popup-open", "")] : []),
		h.DataAttribute("slot", `${slot}-trigger`),
		h.Id(triggerId(model.id)),
		h.Tabindex(0),
		h.OnClick(Message.ClickedTrigger()),
	])
	const close = childAttributes([h.OnClick(Message.ClickedClose())])
	const closeButton = Option.map(parts.closeButton, (className) =>
		h.button(
			[
				h.AriaLabel("Close"),
				h.Class(cn(buttonVariants({ className, size: "icon", variant: "ghost" }))),
				h.DataAttribute("slot", "button"),
				h.Tabindex(0),
				h.Type("button"),
				h.OnClick(Message.ClickedClose()),
			],
			[xmarkIcon(h)],
		),
	)
	const portal = isVisible
		? h.div(
				[
					h.Key(`${model.id}-portal`),
					h.DataAttribute("base-ui-portal", ""),
					h.Id(`${model.id}-portal`),
					h.OnMount(MountDialog({ id: model.id, hasTrigger: inputs.hasTrigger ?? true })),
					h.OnKeyDownPreventDefault((key) =>
						key === "Escape" ? Option.some(Message.PressedEscape()) : Option.none(),
					),
				],
				[
					h.div([
						h.AriaHidden(true),
						h.DataAttribute("base-ui-inert", ""),
						h.Role("presentation"),
						h.Style({ position: "fixed", inset: "0px", userSelect: "none" }),
					]),
					h.div([
						h.AriaHidden(true),
						h.DataAttribute("base-ui-inert", ""),
						h.Class(parts.backdrop),
						...state,
						h.DataAttribute("slot", `${slot}-backdrop`),
						h.Role("presentation"),
						h.Style({ userSelect: "none" }),
					]),
					h.div(
						[
							h.Class(parts.viewport),
							...state,
							h.DataAttribute("slot", `${slot}-viewport`),
							h.Role("presentation"),
						],
						[
							focusGuard(h, "inside", [h.DataAttribute("base-ui-inert", "")]),
							h.div(
								[
									...(parts.isLabelled
										? [
												h.AriaDescribedBy(descriptionId(model.id)),
												h.AriaLabelledBy(titleId(model.id)),
											]
										: []),
									h.Class(parts.popup),
									h.DataAttribute("base-ui-focusable", ""),
									...state,
									h.DataAttribute("slot", `${slot}-popup`),
									h.Id(popupId(model.id)),
									h.Role(parts.role),
									h.Style({ "--nested-dialogs": "0" }),
									h.Tabindex(-1),
								],
								[...inputs.toContent(close), ...Option.toArray(closeButton)],
							),
							focusGuard(h, "inside", [h.DataAttribute("base-ui-inert", "")]),
						],
					),
				],
			)
		: null
	return inputs.toView({ trigger, portal })
})

// CONTENT: `DialogHeader`, `DialogTitle`, ... for the kinds with a title (rendered by the parent).

type TitledKind = "dialog" | "alert-dialog" | "sheet"

const contentStyles = {
	dialog: {
		header: DialogStyles.dialogHeaderStyles,
		title: DialogStyles.dialogTitleStyles,
		description: DialogStyles.dialogDescriptionStyles,
		panel: DialogStyles.dialogPanelStyles,
		footer: DialogStyles.dialogFooterStyles,
		footerDefault: DialogStyles.dialogFooterDefaultStyles,
	},
	"alert-dialog": {
		header: AlertDialogStyles.alertDialogHeaderStyles,
		title: AlertDialogStyles.alertDialogTitleStyles,
		description: AlertDialogStyles.alertDialogDescriptionStyles,
		panel: DialogStyles.dialogPanelStyles,
		footer: AlertDialogStyles.alertDialogFooterStyles,
		footerDefault: AlertDialogStyles.alertDialogFooterDefaultStyles,
	},
	sheet: {
		header: SheetStyles.sheetHeaderStyles,
		title: SheetStyles.sheetTitleStyles,
		description: SheetStyles.sheetDescriptionStyles,
		panel: SheetStyles.sheetPanelStyles,
		footer: SheetStyles.sheetFooterStyles,
		footerDefault: SheetStyles.sheetFooterDefaultStyles,
	},
} as const

export const dialogHeader = <M>(h: HtmlBuilder<M>, kind: TitledKind, children: ReadonlyArray<Html>): Html =>
	h.div([h.Class(cn(contentStyles[kind].header)), h.DataAttribute("slot", `${kind}-header`)], children)

export const dialogTitle = <M>(h: HtmlBuilder<M>, kind: TitledKind, id: string, text: string): Html =>
	h.h2(
		[h.Class(cn(contentStyles[kind].title)), h.DataAttribute("slot", `${kind}-title`), h.Id(titleId(id))],
		[text],
	)

export const dialogDescription = <M>(h: HtmlBuilder<M>, kind: TitledKind, id: string, text: string): Html =>
	h.p(
		[
			h.Class(cn(contentStyles[kind].description)),
			h.DataAttribute("slot", `${kind}-description`),
			h.Id(descriptionId(id)),
		],
		[text],
	)

/** `DialogPanel` / `SheetPanel`: the scrolling body, inside a fading ScrollArea. */
export const dialogPanel = <M>(
	h: HtmlBuilder<M>,
	kind: "dialog" | "sheet",
	id: string,
	children: ReadonlyArray<Html>,
): Html =>
	scrollArea(h, { id: `${id}-panel`, scrollFade: true }, [
		h.div([h.Class(cn(contentStyles[kind].panel)), h.DataAttribute("slot", `${kind}-panel`)], children),
	])

export const dialogFooter = <M>(h: HtmlBuilder<M>, kind: TitledKind, children: ReadonlyArray<Html>): Html =>
	h.div(
		[
			h.Class(cn(contentStyles[kind].footer, contentStyles[kind].footerDefault)),
			h.DataAttribute("slot", `${kind}-footer`),
		],
		children,
	)
