import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { ingestPollSubscriptions } from "../ingest-poll"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"
import { PROVIDERS } from "../../../kit/providers"

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
		subscriptions: ingestPollSubscriptions<Model, Message>((nowMs) =>
			Message.TickedIngestPoll({ nowMs }),
		),
		source: () => platformSource("cloudflare"),
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: PROVIDERS.cloudflare.name, href: PROVIDERS.cloudflare.infraHref },
			{ label: model.zoneName },
		],
	},
)
