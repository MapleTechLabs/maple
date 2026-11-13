import { defineShellLab } from "../shell-lab"
import { Flags, flags, init, Message, Model, update, view } from "../analytics-search-lab"

// `/lab/analytics-search`: Web analytics' Search tab over fixtures (`?state=`).

export const lab = defineShellLab("Web analytics: Search", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/analytics",
	breadcrumbs: [{ label: "Web analytics" }],
})
