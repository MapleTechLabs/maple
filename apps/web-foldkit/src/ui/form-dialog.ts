import { cn } from "@maple/ui/lib/utils"
import {
	formDialogFooterStartStyles,
	formDialogFormStyles,
	formDialogPanelStyles,
} from "@maple/ui/styles/ui/form-dialog"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "./button"
import type * as Dialog from "./dialog"
import * as DialogView from "./dialog-view"

// Port of `FormDialog` (packages/ui/src/components/ui/form-dialog.tsx) over the dialog Submodel:
// a real `<form>`, so Enter in a field submits. The parent owns the Model and the pending state.

export type FormDialogOptions<M> = Readonly<{
	slotId: string
	model: Dialog.Model
	toParentMessage: (message: Dialog.Message) => M
	title: string
	/** Rich copy (a `<Kbd>` inside) as children. */
	description?: string | ReadonlyArray<Html | string>
	onSubmit: M
	submitLabel: string
	cancelLabel?: string
	isPending?: boolean
	isSubmitDisabled?: boolean
	/** See `DialogView`'s `isReturningFocus`. */
	isReturningFocus?: boolean
	submitVariant?: "default" | "destructive"
	footerStart?: Html
	className?: string
	panelClassName?: string
	fields: ReadonlyArray<Html>
}>

export const formDialog = <M>(h: HtmlBuilder<M>, options: FormDialogOptions<M>): Html => {
	const isPending = options.isPending ?? false
	const id = options.model.id
	return h.submodel({
		slotId: options.slotId,
		model: options.model,
		view: DialogView.view,
		toParentMessage: options.toParentMessage,
		viewInputs: {
			hasTrigger: false,
			isReturningFocus: options.isReturningFocus,
			className: options.className,
			hasDescription: options.description !== undefined,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				h.form(
					[
						h.Class(formDialogFormStyles),
						// Submit is ignored while pending or invalid, as `FormDialog`'s handler.
						...(isPending || (options.isSubmitDisabled ?? false)
							? []
							: [h.OnSubmit(options.onSubmit)]),
					],
					[
						DialogView.dialogHeader(h, "dialog", [
							DialogView.dialogTitle(h, "dialog", id, options.title),
							...(options.description === undefined
								? []
								: [DialogView.dialogDescription(h, "dialog", id, options.description)]),
						]),
						...(options.fields.length === 0
							? []
							: [
									DialogView.dialogPanel(
										h,
										"dialog",
										id,
										options.fields,
										cn(formDialogPanelStyles, options.panelClassName),
									),
								]),
						DialogView.dialogFooter(h, "dialog", [
							...(options.footerStart === undefined
								? []
								: [h.div([h.Class(formDialogFooterStartStyles)], [options.footerStart])]),
							button(
								h,
								{
									variant: "outline",
									isDisabled: isPending,
									attributes: isPending ? [] : close,
								},
								[options.cancelLabel ?? "Cancel"],
							),
							button(
								h,
								{
									type: "submit",
									variant: options.submitVariant ?? "default",
									isLoading: isPending,
									isDisabled: isPending || (options.isSubmitDisabled ?? false),
								},
								[options.submitLabel],
							),
						]),
					],
				),
			],
		},
	})
}
