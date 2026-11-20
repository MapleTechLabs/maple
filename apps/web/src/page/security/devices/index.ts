import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/security/devices`: failing policies and vulnerable software from the device sources, in the Security frame. */
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
