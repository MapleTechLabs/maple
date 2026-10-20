import { Flags, flags, init, Message, Model, update } from "../service-map-3d-lab/update"
import { view } from "../service-map-3d-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/service-map-3d` inside the real shell.

export const lab = defineShellLab("Service map 3D", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/service-map-3d",
	breadcrumbs: [{ label: "Lab", href: "/lab" }, { label: "Service map 3D" }],
})
