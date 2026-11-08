import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../alerts-hub-lab"

// `/lab/alerts-hub`: the hub tabs and silence dialog over fixtures (`?state=`).

export const lab = defineShellLab("Alerts hub", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/alerts-hub",
	breadcrumbs,
})
