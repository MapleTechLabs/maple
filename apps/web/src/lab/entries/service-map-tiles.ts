import { Flags, flags, init, Message, Model, update } from "../service-map-tiles/update"
import { view } from "../service-map-tiles/view"
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
