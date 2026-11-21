import type { McpToolRegistrar } from "./types"
import { createMaintenanceWindowAction } from "./create-maintenance-window"
import { deleteMaintenanceWindowAction } from "./delete-maintenance-window"

export function registerMaintenanceWindowTools(server: McpToolRegistrar) {
	const family = server.family({
		name: "manage_maintenance_window",
		title: "Manage Maintenance Window",
		description:
			"Schedule or remove a maintenance window: a planned period in which matching alert rules do not notify.",
		phrases: ["Managing a maintenance window"],
	})
	createMaintenanceWindowAction(family)
	deleteMaintenanceWindowAction(family)
}
