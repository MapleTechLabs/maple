import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, revive, routeChanged, update } from "./update"
import { view } from "./view"

/** `/`: the Overview home page. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"Overview",
	{ Model, Message },
	{
		routes: ["Home"],
		init,
		update,
		routeChanged,
		revive,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Overview", isPageHeading: true }],
	},
)
