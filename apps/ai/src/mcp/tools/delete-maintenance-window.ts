import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DeleteMaintenanceWindowOutput } from "@maple/domain/mcp-outputs"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { deleteWindowErrors } from "../lib/maintenance-windows"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerDeleteMaintenanceWindowTool(server: McpToolRegistrar) {
	server.define({
		name: "delete_maintenance_window",
		title: "Delete Maintenance Window",
		description:
			"Delete a maintenance window. An occurrence in progress ends now (notifications it held back go out), and occurrences ahead are dropped. " +
			"Requires confirm=true. Ids from list_maintenance_windows.",
		parameters: Schema.Struct({
			maintenance_window_id: P.resourceId("alertMaintenanceWindow", "Maintenance window to delete"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		output: DeleteMaintenanceWindowOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting a maintenance window"],
		handler: Effect.fn("McpTool.deleteMaintenanceWindow")(function* (params) {
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call delete_maintenance_window with confirm=true to delete window ${params.maintenance_window_id}.`,
					parameter: "confirm",
				})
			}
			const windowId = yield* P.decodeResourceId(
				"alertMaintenanceWindow",
				"maintenance_window_id",
			)(params.maintenance_window_id)
			const tenant = yield* CurrentMcpTenant
			const windows = yield* AlertMaintenanceWindowsService
			const deleted = yield* windows
				.delete(tenant.orgId, tenant.userId, tenant.roles, windowId)
				.pipe(Effect.catchTags(deleteWindowErrors))
			return { id: deleted.id, name: deleted.name }
		}),
		render: (output) => ({
			title: "Maintenance Window Deleted",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Name", output.name],
				]),
			],
			next: [doc.next("list_maintenance_windows", {}, "the remaining windows")],
		}),
	})
}
