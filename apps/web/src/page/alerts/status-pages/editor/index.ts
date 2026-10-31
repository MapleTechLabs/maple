import { definePage } from "../../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/alerts/status-pages/$pageId`: one instance per page; the tabs are search. */
export const page = definePage(
	"AlertsStatusPage",
	{ Model, Message },
	{
		routes: ["AlertsStatusPage"],
		key: (route) => route.pageId,
		init,
		update,
		routeChanged,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
