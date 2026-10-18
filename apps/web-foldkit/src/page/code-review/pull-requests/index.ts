import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/code-review/pull-requests`: the reviews list and its review sheet (`?review=`). */
export const page = definePage(
	"CodeReviewPullRequests",
	{ Model, Message },
	{
		routes: ["CodeReviewPullRequests"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: () => breadcrumbsOf("pull-requests"),
	},
)
