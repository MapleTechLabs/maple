import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/code-review/issues`: the findings the reviewer filed, and the review sheet (`?review=`). */
export const page = definePage(
	"CodeReviewIssues",
	{ Model, Message },
	{
		routes: ["CodeReviewIssues"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => breadcrumbsOf("issues"),
	},
)
