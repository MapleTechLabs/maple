import { defineShellLab } from "../shell-lab"
import { breadcrumbs, Flags, flags, init, Message, Model, update, view } from "../anomaly-alerts-lab"

// `/lab/anomaly-alerts`: anomaly rules in the editor, an anomaly rule's incident and the Inbox's
// Anomalies view over fixtures (`?state=`).

export const lab = defineShellLab("Anomaly alerts", {
	Model,
	Message,
	Flags,
	flags,
	init,
	update,
	view,
	currentPath: "/lab/anomaly-alerts",
	breadcrumbs,
})
