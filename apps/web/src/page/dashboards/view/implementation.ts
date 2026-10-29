import { implementPage } from "../../contract"
import { entry } from "./index"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	view,
	subscriptions,
	breadcrumbs: (model) => [
		{ label: "Dashboards", href: "/dashboards" },
		{
			label:
				model.status === "Loading"
					? "Loading…"
					: model.document === null
						? "Not found"
						: model.document.name,
		},
	],
})
