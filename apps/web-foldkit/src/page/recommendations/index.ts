import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/recommendations/$recommendationKey`: one instance per recommendation. */
export const page = definePage(
	"Recommendation",
	{ Model, Message },
	{
		routes: ["Recommendation"],
		key: (route) => route.recommendationKey,
		init,
		update,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
