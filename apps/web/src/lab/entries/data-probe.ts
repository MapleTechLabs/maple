import { defineLab } from "../define"
import { init, Message, Model, subscriptions, update, view } from "../data-probe"

/** S6: warehouse facets through the execute batcher and alert rules through a liveQuery. */
export const lab = defineLab("Data probe", {
	Model,
	init,
	update,
	view,
	subscriptions,
	devTools: { Message },
})
