import type { Html, HtmlBuilder } from "foldkit/html"
import { confirmDialog } from "../../../ui/confirm-dialog"
import { displayName } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"

// The list's `ConfirmDialog` (delete); the tag editor is `kit/tag-editor.ts`.

type H = HtmlBuilder<Message>

/** "Delete “name”?", pending until the delete answers. */
export const deleteDialog = (h: H, model: Model): Html =>
	confirmDialog(h, {
		slotId: model.deleteDialog.id,
		model: model.deleteDialog,
		toParentMessage: (message) => Message.GotDeleteDialogMessage({ message }),
		title: ["Delete “", displayName(model.pendingDelete?.name), "”?"],
		description:
			"This dashboard belongs to the whole org: deleting it removes it for everyone, not just you. This cannot be undone. Export the JSON first if you might want it back.",
		confirmLabel: "Delete for everyone",
		isPending: model.isDeleting,
		onConfirm: Message.ClickedConfirmDelete(),
	})
