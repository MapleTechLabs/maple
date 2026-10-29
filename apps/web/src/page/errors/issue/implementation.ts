import { AsyncData } from "foldkit"
import { implementPage } from "../../contract"
import { entry } from "./index"
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

export const implementation = implementPage(entry, {
	init,
	update,
	routeChanged,
	contextChanged,
	view,
	subscriptions,
	breadcrumbs: (model) => [ERRORS_CRUMB, { label: lastCrumb(model) }],
})
