import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../heartbeat-lab"

// `/lab/heartbeat`: a heartbeat monitor's create form and its Ping URL page over fixtures (`?state=`).

export const lab = defineShellLab("Heartbeat monitor", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/heartbeat",
	breadcrumbs,
})
