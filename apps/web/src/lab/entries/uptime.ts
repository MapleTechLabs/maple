import { defineShellLab } from "../shell-lab"
import { Flags, flags, init, Message, Model, update, view } from "../uptime-lab"

// `/lab/uptime`: the HTTP monitor page's charts over a fixture.

export const lab = defineShellLab("Uptime", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/uptime",
	breadcrumbs: [{ label: "Alerts" }, { label: "Uptime" }, { label: "Lab monitor" }],
})
