import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../domains-lab"

// `/lab/domains`: the settings domains tab over fixtures, its dialogs open on demand (`?state=`).

export const lab = defineShellLab("Verified domains", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/domains",
	breadcrumbs,
})
