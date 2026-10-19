import { definePage, pickCommands } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
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
		/** `warmAtoms([getSpanHierarchyResultAtom({ traceId, timestamp: t })])` in the route loader. */
		preload: (route, context) => pickCommands(init(route, context), ["FetchSpanHierarchy"]),
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs,
	},
)
