import { definePage } from "../contract"
import { Message } from "./tabs"
import { Model } from "./tabs"
import { pageCode } from "../code"

/**
 * `/code-review` and its tabs (Analytics, Pull requests, CI, Issues, Settings) as one instance per
 * org: a tab change keeps the instance, so what one tab read serves the next. Filters and windows
 * are search params; each tab's own update handles them.
 */
export const entry = definePage(
	"CodeReview",
	{ Model, Message },
	{
		routes: [
			"CodeReview",
			"CodeReviewPullRequests",
			"CodeReviewCi",
			"CodeReviewIssues",
			"CodeReviewSettings",
		],
		key: () => "code-review",
	},
)

export const page = entry.lazy(pageCode.CodeReview)
