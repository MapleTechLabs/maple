import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, preload, revive, routeChanged, update } from "./update"
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
		revive,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Services", isPageHeading: true }],
	},
)
