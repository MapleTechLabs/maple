import { defineMessageUnion } from "foldkit/message"
import { CopyMessage } from "../copies"
import { LocalLog } from "./model"

export const Message = defineMessageUnion({
	/** The close button, or a trace link that leaves the page. */
	ClosedSheet: {},
	ToggledBodyExpanded: {},
	ToggledErrorExpanded: {},
	/** A copy fact of one of the sheet's copy controls, folded by `updateCopy`. */
	ReceivedCopyMessage: { message: CopyMessage },
	/** Operation `requestShowLog`: a row click on an existing sheet shows `log` and opens it. */
	RequestedShowLog: { log: LocalLog },
})
export type Message = typeof Message.Type
