import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/settings`: one instance per org; a tab switch is a search change (`routeChanged`). */
export const page = definePage(
	"Settings",
	{ Model, Message },
	{
		routes: ["Settings"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs,
	},
)
