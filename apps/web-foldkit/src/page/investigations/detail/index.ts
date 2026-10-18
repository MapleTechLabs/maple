import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
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
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
