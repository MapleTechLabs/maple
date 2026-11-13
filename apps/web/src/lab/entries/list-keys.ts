import { defineShellLab } from "../shell-lab"
import {
	breadcrumbs,
	currentPath,
	Flags,
	flags,
	init,
	Message,
	Model,
	subscriptions,
	update,
	view,
} from "../list-keys-lab"

// `/lab/list-keys`: the list pages that take the row keys, over fixture rows (`?page=`).

export const lab = defineShellLab("List keys", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	subscriptions,
	currentPath,
	breadcrumbs,
})
