import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/chat`: the conversation rail and its tabs, or a shared conversation. One instance per org. */
export const page = definePage(
	"Chat",
	{ Model, Message },
	{
		routes: ["Chat"],
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Chat" }],
	},
)
