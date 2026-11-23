import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../agent-evals-lab"

// `/lab/agent-evals`: the Evals tab, an evaluator's page and a session's scores over fixtures (`?view=`).

export const lab = defineShellLab("Agent evals", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/agent-evals",
	breadcrumbs,
})
