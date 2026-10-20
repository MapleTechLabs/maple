import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/releases/$commitSha`: one instance per commit; a search change arrives as `routeChanged`. */
export const page = definePage(
	"Release",
	{ Model, Message },
	{
		routes: ["Release"],
		key: (route) => route.commitSha,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
