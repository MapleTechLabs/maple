import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/code-review/ci`: GitHub Actions analytics and the runs list, from the CI traces. */
export const page = definePage(
	"CodeReviewCi",
	{ Model, Message },
	{
		routes: ["CodeReviewCi"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => breadcrumbsOf("ci"),
	},
)
