import { implementPage } from "../../contract"
import { entry } from "./index"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	view,
	breadcrumbs: () => [{ label: "Investigations", isPageHeading: true }],
})
