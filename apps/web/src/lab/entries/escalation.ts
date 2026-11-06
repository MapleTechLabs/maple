import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../escalation-lab"

// `/lab/escalation`: escalation chains, their dialog, the rule tier picker and the incident rail (`?state=`).

export const lab = defineShellLab("Escalation chains", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/escalation",
	breadcrumbs,
})
