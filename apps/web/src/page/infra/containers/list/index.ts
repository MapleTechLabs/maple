import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/containers`: the container fleet. Search changes arrive as `routeChanged`. */
export const page = definePage(
	"InfraContainers",
	{ Model, Message },
	{
		routes: ["InfraContainers"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Containers" }],
	},
)
