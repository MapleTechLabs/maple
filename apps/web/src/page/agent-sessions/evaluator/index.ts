import { definePage } from "../../contract"
import { Message } from "./message"
import { Model } from "./model"
import { contextChanged, init, routeChanged, update } from "./update"
import { view } from "./view"

/** `/agent-sessions/evals/$name`: one evaluator's verdicts, where they come from and its latest scores. */
export const page = definePage(
	"AgentSessionEvaluator",
	{ Model, Message },
	{
		routes: ["AgentSessionEvaluator"],
		key: (route) => `AgentSessionEvaluator:${route.name}`,
		init,
		update,
		routeChanged,
		contextChanged,
		view,
		breadcrumbs: (model) => [
			{ label: "Agent sessions", href: "/agent-sessions" },
			{ label: "Evals", href: "/agent-sessions/evals" },
			{ label: model.name },
		],
	},
)
