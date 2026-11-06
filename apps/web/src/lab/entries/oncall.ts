import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../oncall-lab"

// `/lab/oncall`: on-call schedules, their form and calendar, chain targets and paged events (`?state=`).

export const lab = defineShellLab("On-call schedules", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/oncall",
	breadcrumbs,
})
