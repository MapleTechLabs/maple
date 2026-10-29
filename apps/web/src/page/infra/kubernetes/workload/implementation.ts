import { implementPage } from "../../../contract"
import { entry } from "./index"
import { kubernetesBreadcrumbs } from "../../kit/view-tabs"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { summarySource } from "../../../../shell/source-link"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	source: (model) => summarySource(model.summary.data),
	breadcrumbs: (model) => kubernetesBreadcrumbs("workloads", model.search, [{ label: model.workloadName }]),
})
