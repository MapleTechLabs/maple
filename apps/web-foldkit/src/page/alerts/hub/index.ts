import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/alerts`: the incident-first hub (Inbox, Rules, Routing). One instance per org; tabs are search. */
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
		breadcrumbs: () => [{ label: "Alerts" }],
	},
)
