import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { subscriptions } from "./subscription"
import { contextChanged, init, routeChanged, update } from "./update"
import { breadcrumbsOf, view } from "./view"

/** `/agent-sessions/$sessionId`: one session's four views. One instance per session. */
export const page = definePage(
	"AgentSession",
	{ Model, Message },
	{
		routes: ["AgentSession"],
		key: (route) => `AgentSession:${route.sessionId}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: breadcrumbsOf,
	},
)
