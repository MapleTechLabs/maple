import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/investigations/$id`: one instance per investigation; the tab and open action are search state. */
export const page = definePage(
	"Investigation",
	{ Model, Message },
	{
		routes: ["Investigation"],
		key: (route) => route.id,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
