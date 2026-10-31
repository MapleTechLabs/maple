import { implementPage, pickCommands } from "../../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

export const implementation = implementPage(entry, {
	init,
	/** `warmAtoms([getSpanHierarchyResultAtom({ traceId, timestamp: t })])` in the route loader. */
	preload: (route, context) => pickCommands(init(route, context), ["FetchSpanHierarchy"]),
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs,
})
