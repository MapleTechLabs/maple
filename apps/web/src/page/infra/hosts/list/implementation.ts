import { implementPage } from "../../../contract"
import { entry } from "./index"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Hosts" }],
})
