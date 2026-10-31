import { implementPage } from "../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { contextChanged, init, revive, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	revive,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: () => [{ label: "Overview", isPageHeading: true }],
})
