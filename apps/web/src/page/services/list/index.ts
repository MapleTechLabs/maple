import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, preload, routeChanged, update } from "./update"
import { view } from "./view"

/** `/services`: the services list. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"ServicesList",
	{ Model, Message },
	{
		routes: ["Services"],
		init,
		preload,
		update,
		routeChanged,
		reload: Message.ClickedReload(),
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Services" }],
	},
)
