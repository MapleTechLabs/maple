import { implementPage } from "../../contract"
import { entry } from "./index"
import { contextChanged, infraSurfacesSettled, init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	infraSurfacesSettled,
	view,
	breadcrumbs: () => [{ label: "Infrastructure", isPageHeading: true }],
})
