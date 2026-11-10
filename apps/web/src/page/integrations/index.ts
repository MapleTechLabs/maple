import { definePage } from "../contract"
import { entryOfSearch } from "./catalog"
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
			const entry = entryOfSearch(model.search.integration)
			return entry === null
				? [{ label: "Settings", href: "/settings" }, { label: "Integrations" }]
				: [
						{ label: "Settings", href: "/settings" },
						{ label: "Integrations", href: "/integrations" },
						{ label: entry.name },
					]
		},
	},
)
