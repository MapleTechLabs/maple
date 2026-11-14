import { Flags, flags, init, Message, Model, update, view } from "../service-map-tiles-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/service-map-tiles` inside the real shell.

export const lab = defineShellLab("Service map tiles", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/service-map-tiles",
	breadcrumbs: [{ label: "Lab", href: "/lab" }, { label: "Service map tiles" }],
})
