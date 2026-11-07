import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/** `/alerts`: the incident-first hub and its sections. One instance per org; the section is search. */
export const page = definePage(
	"AlertsHub",
	{ Model, Message },
	{
		routes: ["Alerts"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs,
	},
)
