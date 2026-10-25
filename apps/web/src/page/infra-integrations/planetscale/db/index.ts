import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/planetscale/$dbName`: one database's branches; a new database is a new instance. */
export const page = definePage(
	"InfraPlanetscaleDatabase",
	{ Model, Message },
	{
		routes: ["InfraPlanetscaleDatabase"],
		key: (route) => `InfraPlanetscaleDatabase:${route.dbName}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "PlanetScale", href: "/infra/planetscale" },
			{ label: model.dbName },
		],
	},
)
