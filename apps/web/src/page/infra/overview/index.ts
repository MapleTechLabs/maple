import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra`: every source's health, what needs a look first. */
export const page = definePage(
	"InfraOverview",
	{ Model, Message },
	{
		routes: ["Infra"],
		init,
		update,
		routeChanged,
		contextChanged,
		infraSurfacesSettled: contextChanged,
		view,
		breadcrumbs: () => [{ label: "Infrastructure" }],
	},
)
