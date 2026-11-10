import { definePage } from "../../../contract"
import { Message, Model } from "./model"
import { ingestPollSubscriptions } from "../ingest-poll"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"
import { platformSource } from "../../../../shell/source-link"

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
		subscriptions: ingestPollSubscriptions<Model, Message>((nowMs) =>
			Message.TickedIngestPoll({ nowMs }),
		),
		source: () => platformSource("cloudflare"),
		breadcrumbs: (model) => [
			{ label: "Infrastructure", href: "/infra" },
			{ label: "Cloudflare", href: "/infra/cloudflare?view=workers" },
			{ label: model.scriptName },
		],
	},
)
