import * as AttributesPanel from "@maple/web/ui/attributes/attributes-panel"
import * as CopyButton from "@maple/web/ui/copy-button"
import * as Dialog from "@maple/web/ui/dialog"
import * as Tabs from "@maple/web/ui/tabs"
import * as Tooltip from "@maple/web/ui/tooltip"
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
	GotTooltipMessage: { message: Tooltip.Message },
})
export type Message = typeof Message.Type
