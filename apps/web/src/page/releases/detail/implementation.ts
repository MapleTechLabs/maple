import { implementPage } from "../../contract"
import { entry } from "./index"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	breadcrumbs: breadcrumbsOf,
})
