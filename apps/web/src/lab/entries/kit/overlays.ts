import { defineLabWithFlags } from "../../define"
import { Flags, Message, Model } from "../../kit/overlays/model"
import { flags, init, update } from "../../kit/overlays/update"
import { view } from "../../kit/overlays/view"

/** `/lab/kit/overlays`: one @maple/ui overlay per `?item=`, rendered open on mount. */
export const lab = defineLabWithFlags("Kit: overlays", {
	Model,
	Flags,
	flags,
	init,
	update,
	view,
	devTools: { Message },
})
