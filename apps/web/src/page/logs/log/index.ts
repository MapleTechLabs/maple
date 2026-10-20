import { definePage } from "../../contract"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/logs/$logId`: one instance per log key, so picking another log mounts a fresh page. */
export const page = definePage(
	"Log",
	{ Model, Message },
	{
		routes: ["Log"],
		key: (route) => route.logId,
		init,
		update,
		view,
		breadcrumbs: breadcrumbsOf,
	},
)
