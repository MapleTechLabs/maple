import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/cloudflare/$zoneName`: one zone's traffic, DNS and security; another zone is another instance. */
export const page = definePage(
	"InfraCloudflareZone",
	{ Model, Message },
	{
		routes: ["InfraCloudflareZone"],
		key: (route) => `InfraCloudflareZone:${route.zoneName}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Cloudflare", href: "/infra/cloudflare" },
			{ label: model.zoneName },
		],
	},
)
