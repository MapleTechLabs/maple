import { AsyncData } from "foldkit"
import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

const ERRORS_CRUMB = { label: "Errors", href: "/errors" } as const

/** The crumb after "Errors": the issue's type once loaded, else what the page is showing. */
const lastCrumb = (model: Model): string =>
	AsyncData.matchData(model.detail.data, {
		onEmpty: () => "…",
		onFailure: (failure) =>
			failure._tag === "@maple/http/errors/ErrorIssueNotFoundError" ? "Not found" : "Error",
		onData: (detail) => detail.exception_type || detail.error_label || "Unlabelled error",
	})

/** `/errors/issues/$issueId`: one instance per issue; tab and window changes arrive as `routeChanged`. */
export const page = definePage(
	"ErrorIssue",
	{ Model, Message },
	{
		routes: ["ErrorIssue"],
		key: (route) => route.issueId,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [ERRORS_CRUMB, { label: lastCrumb(model) }],
	},
)
