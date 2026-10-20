import { definePage } from "../../contract"
import { Message, Model } from "./model"
import { init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/account`: one instance; a tab switch is a search change (`routeChanged`). */
export const page = definePage(
	"Account",
	{ Model, Message },
	{
		routes: ["Account"],
		init,
		update,
		routeChanged,
		view,
		breadcrumbs,
	},
)
