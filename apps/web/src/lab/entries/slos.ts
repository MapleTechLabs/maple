import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../slos-lab"

// `/lab/slos`: the SLOs tab, the SLO page and the SLO form over fixtures (`?state=`).

export const lab = defineShellLab("SLOs", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/slos",
	breadcrumbs,
})
