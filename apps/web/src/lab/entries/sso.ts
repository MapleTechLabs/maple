import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../sso-lab"

// `/lab/sso`: the settings SSO & SCIM tab over fixtures, its states and dialogs on demand (`?state=`).

export const lab = defineShellLab("SSO & SCIM", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/sso",
	breadcrumbs,
})
