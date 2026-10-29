import { implementPage } from "../../contract"
import { entry } from "./index"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	preload,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: () => [{ label: "Traces", isPageHeading: true }],
})
