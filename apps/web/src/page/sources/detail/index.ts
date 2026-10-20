import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/sources/$sourceId`: one instance per source; a tab link is a `routeChanged`. */
export const page = definePage(
	"SourceDetail",
	{ Model, Message },
	{
		routes: ["Source"],
		key: (route) => route.sourceId,
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
