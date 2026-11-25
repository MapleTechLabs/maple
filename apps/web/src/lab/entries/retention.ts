import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../retention-lab"

// `/lab/retention`: the settings Retention tab over fixtures (`?state=`).

export const lab = defineShellLab("Retention", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/retention",
	breadcrumbs,
})
