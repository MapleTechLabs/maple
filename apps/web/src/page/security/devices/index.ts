import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/security/devices`: the Fleet server's failing policies and vulnerable software, in the Security frame. */
export const page = definePage(
	"SecurityDevices",
	{ Model, Message },
	{
		routes: ["SecurityDevices"],
		key: () => "security-devices",
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: () => breadcrumbsOf("devices"),
	},
)
