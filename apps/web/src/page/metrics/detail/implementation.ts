import { implementPage } from "../../contract"
import { entry } from "./index"
import { backToMetricsHref, contextChanged, init, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: (model) => [
		{ label: "Metrics", href: backToMetricsHref(model.search) },
		{ label: model.metricName },
	],
})
