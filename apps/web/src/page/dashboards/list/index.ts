import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/dashboards`: the org's dashboards. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"DashboardsList",
	{ Model, Message },
	{
		routes: ["Dashboards"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Dashboards", isPageHeading: true }],
	},
)
