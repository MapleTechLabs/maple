import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../role-editor-lab"

// `/lab/role-editor`: a role's editor over fixtures: custom with unsaved changes, built-in read-only, nobody holding it (`?state=`).

export const lab = defineShellLab("Role editor", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/role-editor",
	breadcrumbs,
})
