import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../escalation-editor-lab"

// `/lab/escalation-editor`: the escalation chain editor page over fixtures (`?state=`).

export const lab = defineShellLab("Escalation chain editor", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/escalation-editor",
	breadcrumbs,
})
