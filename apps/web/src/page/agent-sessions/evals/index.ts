import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/agent-sessions/evals`: every evaluator that scored the window's agent runs. */
export const page = definePage(
	"AgentSessionEvals",
	{ Model, Message },
	{
		routes: ["AgentSessionEvals"],
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: () => [{ label: "Agent sessions", href: "/agent-sessions" }, { label: "Evals" }],
	},
)
