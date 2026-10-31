import { implementPage } from "../../../contract"
import { entry } from "./index"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	source: () => platformSource("planetscale"),
	breadcrumbs: (model) => [
		{ label: "Infrastructure", href: "/infra" },
		{ label: "PlanetScale", href: "/infra/planetscale" },
		{ label: model.dbName },
	],
})
