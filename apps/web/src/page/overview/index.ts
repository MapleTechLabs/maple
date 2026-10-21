import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
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
		reload: Message.ClickedReload(),
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Overview" }],
	},
)
