import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/agent-sessions`: the sessions list. Search changes arrive as `routeChanged` and keep the window. */
export const page = definePage(
	"AgentSessionsList",
	{ Model, Message },
	{
		routes: ["AgentSessions"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Agent Sessions" }],
	},
)
