import { McpInvalidInputError, type McpToolFamilyBuilder } from "./types"
import { Effect, Schema } from "effect"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { deleteWindowErrors } from "../lib/maintenance-windows"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export const deleteMaintenanceWindowAction = (family: McpToolFamilyBuilder<"manage_maintenance_window">) =>
	family.action("delete", {
		description:
			"Delete a maintenance window. An occurrence in progress ends now (notifications it held back go out), and occurrences ahead are dropped. " +
			"Requires confirm=true. Ids from list_maintenance_windows.",
		parameters: Schema.Struct({
			maintenance_window_id: P.resourceId("alertMaintenanceWindow", "Maintenance window to delete"),
			confirm: P.flag("Must be true. There is no undo."),
		}),
		hints: { readOnly: false, destructive: true, idempotent: false },
		permission: "alerts:manage",
		handler: Effect.fn("McpTool.deleteMaintenanceWindow")(function* (params) {
			if (params.confirm !== true) {
				return yield* new McpInvalidInputError({
					message: `Deletion not confirmed. Re-call manage_maintenance_window action=delete with confirm=true to delete window ${params.maintenance_window_id}.`,
					parameter: "confirm",
				})
			}
			const windowId = yield* P.decodeResourceId(
				"alertMaintenanceWindow",
				"maintenance_window_id",
			)(params.maintenance_window_id)
			const windows = yield* AlertMaintenanceWindowsService
			const deleted = yield* windows.delete(windowId).pipe(Effect.catchTags(deleteWindowErrors))
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
