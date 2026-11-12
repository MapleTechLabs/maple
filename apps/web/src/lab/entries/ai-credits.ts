import { Flags, flags, init, Message, Model, update, view } from "../ai-credits-lab"
import { defineShellLab } from "../shell-lab"

// `/lab/ai-credits`: the AI credits page (`?state=`) over fixtures.

export const lab = defineShellLab("AI credits", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/settings/billing/ai-credits",
	breadcrumbs: [{ label: "Settings" }, { label: "Billing" }, { label: "AI credits" }],
})
