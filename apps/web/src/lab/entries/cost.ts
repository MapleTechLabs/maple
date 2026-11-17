import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../cost-lab"

// `/lab/cost`: the cost page over synthetic cost (`?state=`).

export const lab = defineShellLab("Cloud cost", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/cost",
	breadcrumbs,
})
