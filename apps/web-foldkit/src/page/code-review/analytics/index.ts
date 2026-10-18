import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/code-review`: review analytics. One instance per org; filters and window are search. */
export const page = definePage(
	"CodeReviewAnalytics",
	{ Model, Message },
	{
		routes: ["CodeReview"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => breadcrumbsOf("analytics"),
	},
)
