import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { OnCallScheduleUpdateRequest } from "@maple/domain/http"
import { OnCallScheduleMutationOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	LayersInput,
	layersParameterDescription,
	memberNames,
	scheduleBlocks,
	toLayers,
	toScheduleRow,
	updateScheduleErrors,
} from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeUpdateRequest = Schema.decodeUnknownEffect(OnCallScheduleUpdateRequest)

export function registerUpdateOnCallScheduleTool(server: McpToolRegistrar) {
	server.define({
		name: "update_oncall_schedule",
		title: "Update On-Call Schedule",
		description:
			"Change an on-call schedule's name, time zone, layers or description. Pass only what changes; layers replaces every layer. " +
			"Overrides are kept. Ids from list_oncall_schedules.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule to change"),
			name: P.optionalText("New name"),
			time_zone: P.optionalText("New IANA time zone"),
			layers: P.optionalJson(LayersInput, `Replaces every layer. ${layersParameterDescription}`),
			description: P.optionalText("New notes"),
		}),
		output: OnCallScheduleMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: true },
		phrases: ["Updating an on-call schedule"],
		handler: Effect.fn("McpTool.updateOnCallSchedule")(function* (params) {
			const scheduleId = yield* P.decodeResourceId("oncallSchedule", "schedule_id")(params.schedule_id)
			if (
				params.name === undefined &&
				params.time_zone === undefined &&
				params.layers === undefined &&
				params.description === undefined
			) {
				return yield* new McpInvalidInputError({
					message: "Nothing to change: pass name, time_zone, layers or description.",
					parameter: "layers",
				})
			}
			const request = yield* decodeUpdateRequest({
				...(params.name === undefined ? undefined : { name: params.name }),
				...(params.time_zone === undefined ? undefined : { timeZone: params.time_zone }),
				...(params.layers === undefined ? undefined : { layers: toLayers(params.layers) }),
				...(params.description === undefined ? undefined : { description: params.description }),
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({
							message: `Invalid on-call schedule: ${String(error)}`,
							parameter: "time_zone",
						}),
				),
			)
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules
				.update(tenant.orgId, tenant.userId, tenant.roles, scheduleId, request)
				.pipe(Effect.catchTags(updateScheduleErrors))
			const names = yield* memberNames(tenant.orgId)
			return { schedule: toScheduleRow(schedule, names) }
		}),
		render: (output) => ({
			title: "On-Call Schedule Updated",
			blocks: scheduleBlocks(output.schedule),
			next: [doc.next("who_is_on_call", { schedule: output.schedule.id }, "who is on call now")],
		}),
	})
}
