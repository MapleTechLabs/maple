import { cn } from "@maple/ui/lib/utils"
import * as AlertDialogStyles from "@maple/ui/styles/ui/alert-dialog"
import {
	confirmDialogIconDestructiveStyles,
	confirmDialogMediaDestructiveStyles,
} from "@maple/ui/styles/ui/confirm-dialog"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { descriptionId, titleId } from "../../../ui/dialog"
import * as DialogView from "../../../ui/dialog-view"
import { dialogFooter, dialogHeader } from "../../../ui/dialog-view"
import { icon } from "../../../ui/icon"
import { displayName } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The list's `ConfirmDialog` (delete); the tag editor is `kit/tag-editor.ts`.

type H = HtmlBuilder<Message>

/** `ConfirmDialog` with the warning media, "Delete “name”?" and the destructive confirm. */
export const deleteDialog = (h: H, model: Model): Html => {
	const id = model.deleteDialog.id
	const name = displayName(model.pendingDelete?.name)
	return h.submodel({
		slotId: id,
		model: model.deleteDialog,
		view: DialogView.view,
		viewInputs: {
			hasTrigger: false,
			toView: ({ portal }) => portal ?? h.empty,
			toContent: (close) => [
				dialogHeader(h, "alert-dialog", [
					h.div(
						[
							h.Class(
								cn(
									AlertDialogStyles.alertDialogMediaStyles,
									confirmDialogMediaDestructiveStyles,
								),
							),
							h.DataAttribute("slot", "alert-dialog-media"),
						],
						[icon(h, "CircleWarningIcon", { className: confirmDialogIconDestructiveStyles })],
					),
					h.h2(
						[
							h.Class(cn(AlertDialogStyles.alertDialogTitleStyles)),
							h.DataAttribute("slot", "alert-dialog-title"),
							h.Id(titleId(id)),
						],
						["Delete “", name, "”?"],
					),
					h.p(
						[
							h.Class(cn(AlertDialogStyles.alertDialogDescriptionStyles)),
							h.DataAttribute("slot", "alert-dialog-description"),
							h.Id(descriptionId(id)),
						],
						[
							"This dashboard belongs to the whole org: deleting it removes it for everyone, not just you. It can’t be undone. Export the JSON first if you might want it back.",
						],
					),
				]),
				dialogFooter(h, "alert-dialog", [
					button(h, { variant: "outline", slot: "alert-dialog-cancel", attributes: close }, [
						"Cancel",
					]),
					button(
						h,
						{ variant: "destructive", attributes: [h.OnClick(Message.ClickedConfirmDelete())] },
						["Delete for everyone"],
					),
				]),
			],
		},
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
	})
}
