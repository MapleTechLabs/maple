import { definePage } from "../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/product-analytics`: product events, funnels and paths. One instance per org. */
export const page = definePage(
	"ProductAnalytics",
	{ Model, Message },
	{
		routes: ["ProductAnalytics"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Product analytics", isPageHeading: true }],
	},
)
