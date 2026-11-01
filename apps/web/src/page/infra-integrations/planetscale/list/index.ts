import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

/** `/infra/planetscale`: the database fleet, or the connect prompt. */
export const page = definePage(
	"InfraPlanetscale",
	{ Model, Message },
	{
		routes: ["InfraPlanetscale"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		source: () => platformSource("planetscale"),
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "PlanetScale" }],
	},
)
