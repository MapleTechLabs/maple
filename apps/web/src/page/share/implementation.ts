import { implementPage } from "../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init: (route) => init(route),
	update: (model, message) => update(model, message),
	routeChanged: (model, route) => routeChanged(model, route),
	view,
	subscriptions,
	breadcrumbs: () => [],
})
