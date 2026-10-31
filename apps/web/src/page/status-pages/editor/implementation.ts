import { implementPage } from "../../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	view,
	subscriptions,
	breadcrumbs: breadcrumbsOf,
})
