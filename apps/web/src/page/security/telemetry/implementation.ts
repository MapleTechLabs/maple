import { implementPage } from "../../contract"
import { entry } from "./index"
import { breadcrumbsOf } from "../kit/layout"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	view,
	subscriptions,
	breadcrumbs: (model) => breadcrumbsOf(model.tab),
})
