import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/infra/cloudflare/workers/$scriptName`: one Worker; another script is another instance. */
export const page = definePage(
	"InfraCloudflareWorker",
	{ Model, Message },
	{
		routes: ["InfraCloudflareWorker"],
		key: (route) => `InfraCloudflareWorker:${route.scriptName}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Cloudflare", href: "/infra/cloudflare?view=workers" },
			{ label: model.scriptName },
		],
	},
)
