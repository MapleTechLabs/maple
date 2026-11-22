import type { McpToolFamilyBuilder } from "./types"
import { Effect, Schema } from "effect"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../tenant"
import { deleteScheduleErrors } from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export const deleteOnCallScheduleAction = (family: McpToolFamilyBuilder<"manage_oncall_schedule">) =>
	family.action("delete", {
		description: "Delete an on-call schedule and every override on it. Ids from list_oncall_schedules.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule to delete"),
		}),
		hints: { readOnly: false, destructive: true, idempotent: false },
		permission: "oncall:manage",
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
			yield* schedules.delete(scheduleId).pipe(Effect.catchTags(deleteScheduleErrors))
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
