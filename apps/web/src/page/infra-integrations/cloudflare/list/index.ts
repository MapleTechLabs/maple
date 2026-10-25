import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/cloudflare`: zones, Workers and queues, or why there are none yet. */
export const page = definePage(
	"InfraCloudflare",
	{ Model, Message },
	{
		routes: ["InfraCloudflare"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => [{ label: "Infrastructure", href: "/infra" }, { label: "Cloudflare" }],
	},
)
