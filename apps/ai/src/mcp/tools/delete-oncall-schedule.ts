import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DeleteOnCallScheduleOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { deleteScheduleErrors } from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerDeleteOnCallScheduleTool(server: McpToolRegistrar) {
	server.define({
		name: "delete_oncall_schedule",
		title: "Delete On-Call Schedule",
		description: "Delete an on-call schedule and every override on it. Ids from list_oncall_schedules.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule to delete"),
		}),
		output: DeleteOnCallScheduleOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an on-call schedule"],
		handler: Effect.fn("McpTool.deleteOnCallSchedule")(function* (params) {
			const scheduleId = yield* P.decodeResourceId("oncallSchedule", "schedule_id")(params.schedule_id)
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			// Read first so the reply names what was deleted.
			const schedule = yield* schedules.get(tenant.orgId, scheduleId).pipe(
				Effect.catchTags({
					"@maple/http/errors/OnCallScheduleNotFoundError":
						deleteScheduleErrors["@maple/http/errors/OnCallScheduleNotFoundError"],
					"@maple/http/errors/AlertPersistenceError":
						deleteScheduleErrors["@maple/http/errors/AlertPersistenceError"],
				}),
			)
			yield* schedules
				.delete(tenant.orgId, tenant.roles, scheduleId)
				.pipe(Effect.catchTags(deleteScheduleErrors))
			return { id: schedule.id, name: schedule.name }
		}),
		render: (output) => ({
			title: "On-Call Schedule Deleted",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Name", output.name],
				]),
			],
			next: [doc.next("list_oncall_schedules", {}, "the remaining schedules")],
		}),
	})
}
