import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { titleOf, view } from "./view"
import { platformSource } from "../../../../shell/source-link"

/** `/infra/railway/$serviceId`: one service's usage; a new service id is a new instance. */
export const page = definePage(
	"InfraRailwayService",
	{ Model, Message },
	{
		routes: ["InfraRailwayService"],
		key: (route) => `InfraRailwayService:${route.serviceId}`,
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
	},
)
