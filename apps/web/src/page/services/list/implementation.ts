import { implementPage } from "../../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { contextChanged, init, preload, revive, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	preload,
	update,
	routeChanged,
	revive,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: () => [{ label: "Services", isPageHeading: true }],
})
