import { implementPage } from "../../contract"
import { entry } from "./index"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	view,
	breadcrumbs: breadcrumbsOf,
})
