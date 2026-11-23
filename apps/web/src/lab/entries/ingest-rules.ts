import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../ingest-rules-lab"

// `/lab/ingest-rules`: the ingest rule list and a saved rule's Impact panel over fixtures (`?state=`).

export const lab = defineShellLab("Ingest rules", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/ingest-rules",
	breadcrumbs,
})
