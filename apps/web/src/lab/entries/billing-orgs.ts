import { Flags, flags, init, Message, Model, update, view } from "../billing-orgs-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/billing-orgs`: the Billing tab per billing role (`?state=`) over fixtures.

export const lab = defineShellLab("Billing orgs", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/billing-orgs",
	breadcrumbs: [{ label: "Settings" }, { label: "Billing" }],
})
