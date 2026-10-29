import { implementPage } from "../contract"
import { entry } from "./index"
import { catalogEntry, integrationOfSearch } from "./catalog"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
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
})
