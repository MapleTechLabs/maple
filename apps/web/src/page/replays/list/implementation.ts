import { implementPage } from "../../contract"
import { entry } from "./index"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	preload,
	update,
	routeChanged,
	contextChanged,
	view,
	breadcrumbs: () => [{ label: "Replays", isPageHeading: true }],
})
