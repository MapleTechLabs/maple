import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** One instance per org; search changes (range, grouping, order, filters) arrive as `routeChanged`. */
export const page = definePage(
	"Cost",
	{ Model, Message },
	{
		routes: ["Cost"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Cost", isPageHeading: true }],
	},
)
