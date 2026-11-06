import { definePage } from "../contract"
import { catalogEntry, integrationOfSearch } from "./catalog"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/integrations`: the hub, or one integration's page (`?integration=`). One instance for both. */
export const page = definePage(
	"Integrations",
	{ Model, Message },
	{
		routes: ["Integrations"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => {
			const integration = integrationOfSearch(model.search.integration)
			return integration === null
				? [{ label: "Settings", href: "/settings" }, { label: "Integrations" }]
				: [
						{ label: "Settings", href: "/settings" },
						{ label: "Integrations", href: "/integrations" },
						{ label: catalogEntry(integration).name },
					]
		},
	},
)
