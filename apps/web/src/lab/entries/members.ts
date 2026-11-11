import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../members-lab"

// `/lab/members`: the settings members tab over fixtures, with the role confirm strip (`?state=`).

export const lab = defineShellLab("Members", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/members",
	breadcrumbs,
})
