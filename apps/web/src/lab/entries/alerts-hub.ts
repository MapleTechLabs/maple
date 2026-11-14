import { defineShellLab } from "../shell-lab"
import { breadcrumbs, currentPath, Flags, flags, init, Message, Model, update, view } from "../alerts-hub-lab"

// `/lab/alerts-hub`: the hub sections and the silence side panel over fixtures (`?state=`), with
// two unacknowledged incidents counted on the sidebar's Inbox.

export const lab = defineShellLab("Alerts hub", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath,
	breadcrumbs,
	seedShell: (shell) => ({ ...shell, alertsInboxCount: 2 }),
})
