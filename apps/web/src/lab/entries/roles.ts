import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../roles-lab"

// `/lab/roles`: the settings Roles tab over fixtures, with its create and delete dialogs (`?state=`).

export const lab = defineShellLab("Roles", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/roles",
	breadcrumbs,
})
