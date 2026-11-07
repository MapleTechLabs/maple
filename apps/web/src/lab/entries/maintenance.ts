import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../maintenance-lab"

// `/lab/maintenance`: maintenance windows in the alerts hub, their dialog and filtered silences (`?state=`).

export const lab = defineShellLab("Maintenance windows", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/maintenance",
	breadcrumbs,
})
