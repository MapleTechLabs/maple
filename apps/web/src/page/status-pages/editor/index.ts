import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/status-pages/$pageId`: one instance per page; Settings, JSON and the live screen are search. */
export const page = definePage(
	"StatusPage",
	{ Model, Message },
	{
		routes: ["StatusPage"],
		key: (route) => route.pageId,
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
