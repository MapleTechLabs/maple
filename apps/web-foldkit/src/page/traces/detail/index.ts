import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/traces/$traceId`: one instance per trace; `spanId`, `view` and `t` arrive as `routeChanged`. */
export const page = definePage(
	"TraceDetail",
	{ Model, Message },
	{
		routes: ["Trace"],
		key: (route) => route.traceId,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs,
	},
)
