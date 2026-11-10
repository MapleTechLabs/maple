// The Timeline tab of the trace detail page, as one Submodel.
export { Message } from "./timeline/message"
export { Model } from "./timeline/model"
export {
	init,
	setColorBy,
	setSelectedSpanId,
	setSpanEvents,
	update,
	type UpdateReturn,
} from "./timeline/update"
export { view } from "./timeline/view"
