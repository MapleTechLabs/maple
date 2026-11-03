import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/metrics`: the metric explorer. One instance per org; search changes arrive as `routeChanged`. */
export const page = definePage(
	"MetricsBrowse",
	{ Model, Message },
	{
		routes: ["Metrics"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Metrics", isPageHeading: true }],
	},
)
