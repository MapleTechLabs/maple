import type { McpToolFamilyBuilder } from "./types"
import { Effect, Schema } from "effect"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../tenant"
import { deleteOverrideErrors } from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export const removeOnCallOverrideAction = (family: McpToolFamilyBuilder<"manage_oncall_schedule">) =>
	family.action("remove_override", {
		description:
			"Delete an override so the schedule's layers decide again. Override ids come from manage_oncall_schedule action=add_override or the REST overrides list.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule the override is on"),
			override_id: P.resourceId("oncallOverride", "Override to delete"),
		}),
		hints: { readOnly: false, destructive: true, idempotent: false },
		permission: "oncall:manage",
		handler: Effect.fn("McpTool.deleteOnCallOverride")(function* (params) {
			const scheduleId = yield* P.decodeResourceId("oncallSchedule", "schedule_id")(params.schedule_id)
			const overrideId = yield* P.decodeResourceId("oncallOverride", "override_id")(params.override_id)
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.get(tenant.orgId, scheduleId).pipe(
				Effect.catchTags({
					"@maple/http/errors/OnCallScheduleNotFoundError":
						deleteOverrideErrors["@maple/http/errors/OnCallScheduleNotFoundError"],
					"@maple/http/errors/AlertPersistenceError":
						deleteOverrideErrors["@maple/http/errors/AlertPersistenceError"],
				}),
			)
			yield* schedules
				.deleteOverride(scheduleId, overrideId)
				.pipe(Effect.catchTags(deleteOverrideErrors))
			return { id: overrideId, scheduleId, scheduleName: schedule.name }
		}),
		render: (output) => ({
			title: "On-Call Override Deleted",
			blocks: [
				doc.fields([
					["ID", output.id],
					["Schedule", `${output.scheduleName} (${output.scheduleId})`],
				]),
			],
			next: [doc.next("who_is_on_call", { schedule: output.scheduleId }, "who is on call now")],
		}),
	})
