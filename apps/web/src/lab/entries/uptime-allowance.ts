import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../uptime-allowance-lab"

// `/lab/uptime-allowance`: the new-monitor form at each point of the monitor allowance (`?state=`).

export const lab = defineShellLab("Uptime monitor allowance", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/uptime-allowance",
	breadcrumbs,
})
