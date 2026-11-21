import type { McpToolRegistrar } from "./types"
import { createOnCallScheduleAction } from "./create-oncall-schedule"
import { updateOnCallScheduleAction } from "./update-oncall-schedule"
import { deleteOnCallScheduleAction } from "./delete-oncall-schedule"
import { addOnCallOverrideAction } from "./create-oncall-override"
import { removeOnCallOverrideAction } from "./delete-oncall-override"

export function registerOnCallScheduleTools(server: McpToolRegistrar) {
	const family = server.family({
		name: "manage_oncall_schedule",
		title: "Manage On-Call Schedule",
		description:
			"Create, change or delete an on-call schedule (its rotation layers), or add and remove an override that puts one person on call for a period.",
		phrases: ["Managing an on-call schedule"],
	})
	createOnCallScheduleAction(family)
	updateOnCallScheduleAction(family)
	deleteOnCallScheduleAction(family)
	addOnCallOverrideAction(family)
	removeOnCallOverrideAction(family)
}
