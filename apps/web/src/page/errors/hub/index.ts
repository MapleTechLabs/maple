import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

/** `/errors`: the issues list. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"ErrorsHub",
	{ Model, Message },
	{
		routes: ["Errors"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Errors", isPageHeading: true }],
	},
)
