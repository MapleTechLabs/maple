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
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/** `ConfirmDialog` for `useBlocker`: leaving with unsaved widget changes. */
export const leaveDialog = (h: H, model: Model): Html => {
	const id = model.leaveDialog.id
	return h.submodel({
		slotId: id,
		model: model.leaveDialog,
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
						[icon(h, "AlertWarningIcon", { className: confirmDialogIconDestructiveStyles })],
					),
					h.h2(
						[
							h.Class(cn(AlertDialogStyles.alertDialogTitleStyles)),
							h.DataAttribute("slot", "alert-dialog-title"),
							h.Id(titleId(id)),
						],
						["Unsaved changes"],
					),
					h.p(
						[
							h.Class(cn(AlertDialogStyles.alertDialogDescriptionStyles)),
							h.DataAttribute("slot", "alert-dialog-description"),
							h.Id(descriptionId(id)),
						],
						["You have unsaved widget changes. Are you sure you want to leave?"],
					),
				]),
				dialogFooter(h, "alert-dialog", [
					button(h, { variant: "outline", slot: "alert-dialog-cancel", attributes: close }, [
						"Stay",
					]),
					button(h, { variant: "destructive", attributes: [h.OnClick(Message.ClickedDiscard())] }, [
						"Discard changes",
					]),
				]),
			],
		},
		toParentMessage: (message) => Message.GotLeaveDialogMessage({ message }),
	})
}
