import type { Html, HtmlBuilder } from "foldkit/html"
import { confirmDialog } from "../../ui/confirm-dialog"
import { DISCONNECTS } from "./disconnect"
import { Message } from "./message"
import type { Model } from "./model"

/** The integration's `ConfirmDialog` before disconnecting, opened by `ClickedDisconnect`. */
export const disconnectDialog = (h: HtmlBuilder<Message>, model: Model, integration: string): Html => {
	const spec = DISCONNECTS.get(integration)
	return spec === undefined
		? h.empty
		: confirmDialog(h, {
				slotId: "integration-disconnect",
				model: model.disconnect.dialog,
				toParentMessage: (message) => Message.GotDisconnectDialogMessage({ message }),
				title: spec.title,
				description: spec.description,
				confirmLabel: spec.confirmLabel,
				onConfirm: Message.ConfirmedDisconnect(),
			})
}
