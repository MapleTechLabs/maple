import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/logs`: the logs stream. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"LogsList",
	{ Model, Message },
	{
		routes: ["Logs"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Logs" }],
	},
)
