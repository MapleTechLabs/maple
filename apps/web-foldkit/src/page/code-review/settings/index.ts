import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { init, update } from "./update"
import { view } from "./view"

/** `/code-review/settings`: the review model, the default rules and each repository's reviews. */
export const page = definePage(
	"CodeReviewSettings",
	{ Model, Message },
	{
		routes: ["CodeReviewSettings"],
		init,
		update,
		view,
		breadcrumbs: () => breadcrumbsOf("settings"),
	},
)
