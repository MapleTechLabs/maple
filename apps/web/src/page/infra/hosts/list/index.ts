import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/hosts`: the host fleet. Search changes arrive as `routeChanged`. */
export const page = definePage(
	"InfraHosts",
	{ Model, Message },
	{
		routes: ["InfraHosts"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Hosts" }],
	},
)
