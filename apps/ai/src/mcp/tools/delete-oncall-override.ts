import type { McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { DeleteOnCallOverrideOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { deleteOverrideErrors } from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

export function registerDeleteOnCallOverrideTool(server: McpToolRegistrar) {
	server.define({
		name: "delete_oncall_override",
		title: "Delete On-Call Override",
		description:
			"Delete an override so the schedule's layers decide again. Override ids come from create_oncall_override or the REST overrides list.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule the override is on"),
			override_id: P.resourceId("oncallOverride", "Override to delete"),
		}),
		output: DeleteOnCallOverrideOutput,
		hints: { readOnly: false, destructive: true, idempotent: false },
		phrases: ["Deleting an on-call override"],
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
				.deleteOverride(tenant.orgId, tenant.roles, scheduleId, overrideId)
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
}
