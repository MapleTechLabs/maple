import { cn } from "@maple/ui/lib/utils"
import * as AlertDialogStyles from "@maple/ui/styles/ui/alert-dialog"
import * as CommandStyles from "@maple/ui/styles/ui/command"
import * as DialogStyles from "@maple/ui/styles/ui/dialog"
import * as SheetStyles from "@maple/ui/styles/ui/sheet"
import { Option } from "effect"
import { Submodel } from "foldkit"
import {
	type Attribute,
	type ChildAttribute,
	childAttributes,
	type Html,
	type HtmlBuilder,
} from "foldkit/html"
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
import { button } from "./button"
import { icon } from "./icon"
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
const partsOf = (kind: Kind, side: SheetSide, className: string | undefined, isBottomStick = true): Parts => {
	switch (kind) {
		case "dialog":
			return {
				backdrop: cn(DialogStyles.dialogBackdropStyles),
				viewport: cn(
					DialogStyles.dialogViewportStyles,
					isBottomStick && DialogStyles.dialogViewportBottomStickStyles,
				),
				popup: cn(
					DialogStyles.dialogPopupStyles,
					isBottomStick && DialogStyles.dialogPopupBottomStickStyles,
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
	/** `showCloseButton={false}`: the content renders its own close. */
	showCloseButton?: boolean
	/** `closeProps={{ className }}`: classes merged onto the close button's own. */
	closeClassName?: string
	/** Base UI points `aria-describedby` at a description only when one renders. */
	hasDescription?: boolean
	/** Likewise `aria-labelledby` at a title: a popup with its own chrome renders none. */
	hasTitle?: boolean
	/** `bottomStickOnMobile={false}`: the dialog stays centred on narrow screens. */
	isBottomStickOnMobile?: boolean
	/** Open dialogs nested in this one: Base UI fades and scales the parent popup behind them. */
	nestedDialogs?: number
	/** Opened from inside another dialog: no backdrop of its own, `data-nested` on its parts. */
	isNested?: boolean
	/** `initialFocus={popupRef}`: focus lands on the popup itself, not its first control. */
	isPopupFocused?: boolean
	/** `false`: closing does not hand focus back (focus ends on the body). */
	isReturningFocus?: boolean
}>

const slotPrefix = (kind: Kind) => kind

export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
	const parts = partsOf(model.kind, inputs.side ?? "right", inputs.className, inputs.isBottomStickOnMobile)
	const slot = slotPrefix(model.kind)
	const isVisible = isMounted(model.isOpen, model.animation)
	const nestedDialogs = inputs.nestedDialogs ?? 0
	const isNested = inputs.isNested ?? false
	const state = stateAttributes(h, model.isOpen, model.animation)
	const nesting = [
		...(isNested ? [h.DataAttribute("nested", "")] : []),
		...(nestedDialogs > 0 ? [h.DataAttribute("nested-dialog-open", "")] : []),
	]
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
	const closeButton = Option.map(
		Option.filter(parts.closeButton, () => inputs.showCloseButton !== false),
		(className) =>
			button(
				h,
				{
					className: cn(className, inputs.closeClassName),
					size: "icon",
					variant: "ghost",
					attributes: [h.AriaLabel("Close"), h.Tabindex(0), h.OnClick(Message.ClickedClose())],
				},
				[icon(h, "XmarkIcon")],
			),
	)
	const portal = isVisible
		? h.div(
				[
					h.Key(`${model.id}-portal`),
					h.DataAttribute("base-ui-portal", ""),
					h.Id(`${model.id}-portal`),
					h.OnMount(
						MountDialog({
							id: model.id,
							hasTrigger: inputs.hasTrigger ?? true,
							isPopupFocused: inputs.isPopupFocused ?? false,
							isReturningFocus: inputs.isReturningFocus ?? true,
						}),
					),
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
					...(isNested
						? []
						: [
								h.div([
									h.AriaHidden(true),
									h.DataAttribute("base-ui-inert", ""),
									h.Class(parts.backdrop),
									...state,
									h.DataAttribute("slot", `${slot}-backdrop`),
									h.Role("presentation"),
									h.Style({ userSelect: "none" }),
								]),
							]),
					h.div(
						[
							...(nestedDialogs > 0 ? [h.AriaHidden(true)] : []),
							h.Class(parts.viewport),
							...state,
							...nesting,
							h.DataAttribute("slot", `${slot}-viewport`),
							h.Role("presentation"),
						],
						[
							focusGuard(h, "inside", [h.DataAttribute("base-ui-inert", "")]),
							h.div(
								[
									...(parts.isLabelled && inputs.hasTitle !== false
										? [
												...(inputs.hasDescription === false
													? []
													: [h.AriaDescribedBy(descriptionId(model.id))]),
												h.AriaLabelledBy(titleId(model.id)),
											]
										: []),
									h.Class(parts.popup),
									h.DataAttribute("base-ui-focusable", ""),
									...state,
									...nesting,
									h.DataAttribute("slot", `${slot}-popup`),
									h.Id(popupId(model.id)),
									h.Role(parts.role),
									h.Style({ "--nested-dialogs": String(nestedDialogs) }),
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

export const dialogHeader = <M>(
	h: HtmlBuilder<M>,
	kind: TitledKind,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[h.Class(cn(contentStyles[kind].header, className)), h.DataAttribute("slot", `${kind}-header`)],
		children,
	)

export const dialogTitle = <M>(
	h: HtmlBuilder<M>,
	kind: TitledKind,
	id: string,
	text: string | ReadonlyArray<Html | string>,
	className?: string,
): Html =>
	h.h2(
		[
			h.Class(cn(contentStyles[kind].title, className)),
			h.DataAttribute("slot", `${kind}-title`),
			h.Id(titleId(id)),
		],
		typeof text === "string" ? [text] : text,
	)

/** `text` as runs where the JSX interpolates, so the text nodes split the same. */
export const dialogDescription = <M>(
	h: HtmlBuilder<M>,
	kind: TitledKind,
	id: string,
	text: string | ReadonlyArray<Html | string>,
	className?: string,
): Html =>
	h.p(
		[
			h.Class(cn(contentStyles[kind].description, className)),
			h.DataAttribute("slot", `${kind}-description`),
			h.Id(descriptionId(id)),
		],
		typeof text === "string" ? [text] : text,
	)

/** `DialogPanel` / `SheetPanel`: the scrolling body, inside a fading ScrollArea. */
export const dialogPanel = <M>(
	h: HtmlBuilder<M>,
	kind: "dialog" | "sheet",
	id: string,
	children: ReadonlyArray<Html>,
	className?: string,
	/** A Mount on the ScrollArea viewport (its fades) and the scrollbar it sizes (`trackScrollbar`). */
	measured?: Readonly<{ viewportAttributes: ReadonlyArray<Attribute<M>> }>,
): Html =>
	scrollArea(
		h,
		{
			idPrefix: `${id}-panel`,
			scrollFade: true,
			viewportAttributes: measured?.viewportAttributes,
			hasMeasuredScrollbar: measured !== undefined,
		},
		[
			h.div(
				[h.Class(cn(contentStyles[kind].panel, className)), h.DataAttribute("slot", `${kind}-panel`)],
				children,
			),
		],
	)

export const dialogFooter = <M>(
	h: HtmlBuilder<M>,
	kind: TitledKind,
	children: ReadonlyArray<Html>,
	className?: string,
): Html =>
	h.div(
		[
			h.Class(cn(contentStyles[kind].footer, contentStyles[kind].footerDefault, className)),
			h.DataAttribute("slot", `${kind}-footer`),
		],
		children,
	)
