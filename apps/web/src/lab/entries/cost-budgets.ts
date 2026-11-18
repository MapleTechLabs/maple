import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../cost-budgets-lab"

// `/lab/cost-budgets`: the Budgets list and the budget editor over fixtures (`?state=`).

export const lab = defineShellLab("Cloud cost budgets", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/cost/budgets",
	breadcrumbs,
})
