import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { subscriptions } from "./subscription"
import { view } from "./view"

/** `/agent-sessions/tools/$toolName`: one tool's charts, failures and sessions. One instance per tool. */
export const page = definePage(
	"AgentSessionTool",
	{ Model, Message },
	{
		routes: ["AgentSessionTool"],
		key: (route) => `AgentSessionTool:${route.toolName}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		subscriptions,
		breadcrumbs: (model) => [
			{ label: "Agent sessions", href: "/agent-sessions" },
			{ label: "Tools", href: "/agent-sessions/tools" },
			{ label: model.toolName },
		],
	},
)
