import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../aws-connection-lab"

// `/lab/aws-connection`: the AWS connected card and connect flow around the Cost module (`?state=`).

export const lab = defineShellLab("AWS connection", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/aws-connection",
	breadcrumbs,
})
