import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../incident-actions-lab"

// `/lab/incident-actions`: the incident page and a rule's History tab over fixtures (`?state=`).

export const lab = defineShellLab("Incident actions", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/alerts",
	breadcrumbs,
})
