import { implementPage } from "../../../contract"
import { entry } from "./index"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	breadcrumbs: (model) => kubernetesBreadcrumbs("pods", model.search),
})
