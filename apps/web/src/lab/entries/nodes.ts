import { Flags, flags, init, Message, Model, update, view } from "../nodes-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/nodes`: every provenance-canvas node and edge state, inside the real shell.

export const lab = defineShellLab("Provenance nodes", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/nodes",
	breadcrumbs: [{ label: "Node Lab" }],
})
