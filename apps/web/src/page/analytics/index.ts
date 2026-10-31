import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/analytics`: web analytics. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"Analytics",
	{ Model, Message },
	{
		routes: ["Analytics"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Web Analytics", isPageHeading: true }],
	},
)
