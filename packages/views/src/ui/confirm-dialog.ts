import { cn } from "@maple/ui/lib/utils"
import { alertDialogMediaStyles } from "@maple/ui/styles/ui/alert-dialog"
import {
	confirmDialogIconDestructiveStyles,
	confirmDialogMediaDestructiveStyles,
} from "@maple/ui/styles/ui/confirm-dialog"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import type * as Dialog from "./dialog"
import * as DialogView from "./dialog-view"
import { icon } from "./icon"

// Port of `ConfirmDialog` (packages/ui/src/components/ui/confirm-dialog.tsx) over the alert-dialog
// Submodel. The parent owns the Model (`Dialog.init(id, "alert-dialog")`) and the pending state.

export type ConfirmDialogOptions<M> = Readonly<{
	slotId: string
	model: Dialog.Model
	toParentMessage: (message: Dialog.Message) => M
	/** Rich copy (a name kept on one line) as children. */
	title: string | ReadonlyArray<Html | string>
	/** Rich copy (a highlighted name) as children. */
	description?: string | ReadonlyArray<Html | string>
	/** Content between the header and the footer (`children`). */
	children?: ReadonlyArray<Html | string>
	confirmLabel: string
	/** `icon={null}`: drops the warning media block. */
	hasIcon?: boolean
	cancelLabel?: string
	tone?: "destructive" | "default"
	onConfirm: M
	/** `secondaryAction`: an outline button between Cancel and the confirm (a non-destructive choice). */
	secondaryAction?: Readonly<{ label: string; onClick: M }>
	isPending?: boolean
	isConfirmDisabled?: boolean
	className?: string
	/** `icon`: replaces the warning glyph in the media tile. */
	icon?: Html
	/** Opened from inside another dialog (Base UI nesting: no second backdrop). */
	isNested?: boolean
}>

/** The confirm-before-acting dialog, opened from code (no trigger), placed anywhere in the page. */
export const confirmDialog = <M>(h: HtmlBuilder<M>, options: ConfirmDialogOptions<M>): Html => {
	const tone = options.tone ?? "destructive"
	const isPending = options.isPending ?? false
	const id = options.model.id
	return h.submodel({
		slotId: options.slotId,
		model: options.model,
		view: DialogView.view,
		toParentMessage: options.toParentMessage,
		viewInputs: {
			hasTrigger: false,
			isNested: options.isNested,
			className: options.className,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "alert-dialog", [
					...(options.hasIcon === false
						? []
						: [
								h.div(
									[
										h.Class(
											cn(
												alertDialogMediaStyles,
												tone === "destructive" && confirmDialogMediaDestructiveStyles,
											),
										),
										h.DataAttribute("slot", "alert-dialog-media"),
									],
									[
										options.icon ??
											icon(h, "AlertWarningIcon", {
												className: cn(
													tone === "destructive" &&
														confirmDialogIconDestructiveStyles,
												),
											}),
									],
								),
							]),
					DialogView.dialogTitle(h, "alert-dialog", id, options.title),
					...(options.description === undefined
						? []
						: [DialogView.dialogDescription(h, "alert-dialog", id, options.description)]),
				]),
				...(options.children === undefined ? [] : [h.div([h.Class("px-6 py-2")], options.children)]),
				DialogView.dialogFooter(h, "alert-dialog", [
					button(
						h,
						{
							variant: "outline",
							slot: "alert-dialog-cancel",
							isDisabled: isPending,
							attributes: isPending ? [] : close,
						},
						[options.cancelLabel ?? "Cancel"],
					),
					...(options.secondaryAction === undefined
						? []
						: [
								button(
									h,
									{
										variant: "outline",
										isDisabled: isPending,
										attributes: [h.OnClick(options.secondaryAction.onClick)],
									},
									[options.secondaryAction.label],
								),
							]),
					button(
						h,
						{
							variant: tone === "destructive" ? "destructive" : "default",
							isLoading: isPending,
							isDisabled: isPending || (options.isConfirmDisabled ?? false),
							attributes: [h.OnClick(options.onConfirm)],
						},
						[options.confirmLabel],
					),
				]),
			],
		},
	})
}
