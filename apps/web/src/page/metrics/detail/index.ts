import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { pageCode } from "../../code"

/** `/metrics/$metricName`: one instance per metric; query changes arrive as `routeChanged`. */
export const entry = definePage(
	"MetricDetail",
	{ Model, Message },
	{ routes: ["Metric"], key: (route) => `Metric:${route.metricName}` },
)

export const page = entry.lazy(pageCode.MetricDetail)
