import { definePage } from "../../contract"
import { breadcrumbsOf } from "./view"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/security/cloud` and its finding detail, in the Security frame, for an org in the `cloudSecurity` rollout. */
export const page = definePage(
	"SecurityCloud",
	{ Model, Message },
	{
		routes: ["SecurityCloud", "SecurityCloudFinding"],
		key: () => "security-cloud",
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
