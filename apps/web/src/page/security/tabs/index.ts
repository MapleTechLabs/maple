import { definePage } from "../../contract"
import { breadcrumbsOf } from "../kit/layout"
import { Message, Model } from "./model"
import { subscriptions } from "./subscription"
import { init, routeChanged, update } from "./update"
import { view } from "./view"

/**
 * `/security/code` and its tabs (Overview, Findings, Runs) as one instance per org: a tab change keeps
 * the instance, so the targets, runs and findings one tab read serve the next.
 */
export const page = definePage(
	"Security",
	{ Model, Message },
	{
		routes: ["SecurityCode", "SecurityCodeFindings", "SecurityCodeRuns"],
		key: () => "security",
		init,
		update,
		routeChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => breadcrumbsOf("code", model.tab),
	},
)
