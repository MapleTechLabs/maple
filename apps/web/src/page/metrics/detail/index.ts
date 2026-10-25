import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { backToMetricsHref, contextChanged, init, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

/** `/metrics/$metricName`: one instance per metric; query changes arrive as `routeChanged`. */
export const page = definePage(
	"MetricDetail",
	{ Model, Message },
	{
		routes: ["Metric"],
		key: (route) => `Metric:${route.metricName}`,
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
	},
)
