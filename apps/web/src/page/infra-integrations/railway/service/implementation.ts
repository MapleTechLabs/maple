import { implementPage } from "../../../contract"
import { entry } from "./index"
import { contextChanged, init, routeChanged, update } from "./update"
import { titleOf, view } from "./view"
import { platformSource } from "../../../../shell/source-link"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	source: () => platformSource("railway"),
	breadcrumbs: (model) => [
		{ label: "Infrastructure", href: "/infra" },
		{ label: "Railway", href: "/infra/railway" },
		{ label: titleOf(model) },
	],
})
