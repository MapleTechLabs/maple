import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/traces`: the trace list. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"TracesList",
	{ Model, Message },
	{
		routes: ["Traces"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Traces" }],
	},
)
