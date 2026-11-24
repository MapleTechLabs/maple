import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../grouping-rules-lab"

// `/lab/grouping-rules`: the error grouping rules editor from Settings > Automation (`?state=`).

export const lab = defineShellLab("Error grouping rules", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/grouping-rules",
	breadcrumbs,
})
