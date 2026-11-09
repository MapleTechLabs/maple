import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { breadcrumbs, view } from "./view"

/**
 * `/alerts` (the Inbox) and `/alerts/<section>`: the incident-first hub as one instance per org, so a
 * section change keeps what the last one read.
 */
export const page = definePage(
	"AlertsHub",
	{ Model, Message },
	{
		routes: ["Alerts", "AlertsSection"],
		key: () => "alerts",
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs,
	},
)
