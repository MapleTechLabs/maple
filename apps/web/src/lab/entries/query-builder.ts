import { flags } from "../query-builder-lab/flags"
import { Flags, Message, Model } from "../query-builder-lab/model"
import { init, update } from "../query-builder-lab/update"
import { view } from "../query-builder-lab/view"
import { defineShellLab } from "../shell-lab"

// `/lab/query-builder`: the query builder MVP over the
// session's org, inside the real shell.
// TODO(lab-query-builder): the where clause autocomplete listbox and `sessionTimeRangeSearchMiddleware`.

export const lab = defineShellLab("Query builder", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/query-builder",
	breadcrumbs: [{ label: "Overview", href: "/" }, { label: "Query Builder Lab" }],
})
