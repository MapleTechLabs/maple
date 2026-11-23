import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../ingest-rule-lab"

// `/lab/ingest-rule`: the ingest rule editor over fixture logs (`?state=`).

export const lab = defineShellLab("Ingest rule editor", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/ingest-rule",
	breadcrumbs,
})
