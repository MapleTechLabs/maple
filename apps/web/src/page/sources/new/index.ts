import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/sources/new`: one instance per visit; `?platform=` or `?integration=` moves between the steps. */
export const page = definePage(
	"SourcesNew",
	{ Model, Message },
	{
		routes: ["SourcesNew"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
