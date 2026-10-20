import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/sources/new`: one instance per visit; `?platform=` moves between steps 1 and 2. */
export const page = definePage(
	"SourcesNew",
	{ Model, Message },
	{
		routes: ["SourcesNew"],
		init,
		update,
		routeChanged,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
