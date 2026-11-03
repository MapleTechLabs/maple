import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/agent-sessions/tools`: every tool the window's agents called. Search changes arrive as `routeChanged`. */
export const page = definePage(
	"AgentSessionTools",
	{ Model, Message },
	{
		routes: ["AgentSessionTools"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Agent sessions", href: "/agent-sessions" }, { label: "Tools" }],
	},
)
