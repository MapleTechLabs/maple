import type { Html, HtmlBuilder } from "foldkit/html"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { Message } from "./message"
import type { Model } from "./model"

type H = HtmlBuilder<Message>

/** `ConfirmDialog` for `useBlocker`: leaving with unsaved widget changes. */
export const leaveDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: model.leaveDialog.id,
		model: model.leaveDialog,
		toParentMessage: (message) => Message.GotLeaveDialogMessage({ message }),
		title: "Unsaved changes",
		description: "You have unsaved widget changes. Are you sure you want to leave?",
		cancelLabel: "Stay",
		confirmLabel: "Discard changes",
		onConfirm: Message.ClickedDiscard(),
	})
