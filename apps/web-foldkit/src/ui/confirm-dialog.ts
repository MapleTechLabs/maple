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
	title: string
	/** Text, or rich children (a highlighted name inside the sentence). */
	description?: string | ReadonlyArray<Html | string>
	confirmLabel: string
	cancelLabel?: string
	tone?: "destructive" | "default"
	onConfirm: M
	isPending?: boolean
	isConfirmDisabled?: boolean
	className?: string
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
			className: options.className,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				DialogView.dialogHeader(h, "alert-dialog", [
					h.div(
						[
							h.Class(cn(alertDialogMediaStyles, tone === "destructive" && confirmDialogMediaDestructiveStyles)),
							h.DataAttribute("slot", "alert-dialog-media"),
						],
						[
							icon(h, "AlertWarningIcon", {
								className: cn(tone === "destructive" && confirmDialogIconDestructiveStyles),
							}),
						],
					),
					DialogView.dialogTitle(h, "alert-dialog", id, options.title),
					...(options.description === undefined
						? []
						: [DialogView.dialogDescription(h, "alert-dialog", id, options.description)]),
				]),
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
