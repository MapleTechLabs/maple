import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../audit-log-lab"

// `/lab/audit-log`: the settings audit log tab over fixtures (`?state=`).

export const lab = defineShellLab("Audit log", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/audit-log",
	breadcrumbs,
})
