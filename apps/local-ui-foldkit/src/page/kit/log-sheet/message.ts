import * as AttributesPanel from "@maple/web-foldkit/ui/attributes/attributes-panel"
import * as CopyButton from "@maple/web-foldkit/ui/copy-button"
import * as Dialog from "@maple/web-foldkit/ui/dialog"
import * as Tabs from "@maple/web-foldkit/ui/tabs"
import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"

export const Message = defineMessageUnion({
	/** The close button, or a trace link that leaves the page. */
	ClosedSheet: {},
	/** The backdrop, Escape and the transition, through the kit's Dialog. */
	GotDialogMessage: { message: Dialog.Message },
	ToggledBodyExpanded: {},
	ToggledErrorExpanded: {},
	GotTabsMessage: { message: Tabs.Message },
	GotAttributesMessage: { message: AttributesPanel.Message },
	GotCopyMessage: { id: Schema.String, message: CopyButton.Message },
})
export type Message = typeof Message.Type
