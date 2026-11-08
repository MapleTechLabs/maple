import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { OnCallScheduleCreateRequest } from "@maple/domain/http"
import { OnCallScheduleMutationOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	createScheduleErrors,
	LayersInput,
	layersParameterDescription,
	memberNames,
	scheduleBlocks,
	toLayers,
	toScheduleRow,
} from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeCreateRequest = Schema.decodeUnknownEffect(OnCallScheduleCreateRequest)

export function registerCreateOnCallScheduleTool(server: McpToolRegistrar) {
	server.define({
		name: "create_oncall_schedule",
		title: "Create On-Call Schedule",
		description:
			"Create an on-call schedule: layers that each rotate workspace members daily, weekly or every N hours in one time zone, optionally limited to weekly windows. " +
			"Later layers sit on top of earlier ones; overrides (create_oncall_override) beat every layer.",
		parameters: Schema.Struct({
			name: P.text("Schedule name, e.g. 'Checkout primary'"),
			time_zone: P.text("IANA time zone handoffs are read in, e.g. 'Europe/Berlin'"),
			layers: P.json(LayersInput, layersParameterDescription),
			description: P.optionalText("Free-form notes"),
		}),
		output: OnCallScheduleMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating an on-call schedule"],
		handler: Effect.fn("McpTool.createOnCallSchedule")(function* (params) {
			const request = yield* decodeCreateRequest({
				name: params.name,
				timeZone: params.time_zone,
				layers: toLayers(params.layers),
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
				.create(tenant.orgId, tenant.userId, tenant.roles, request)
				.pipe(Effect.catchTags(createScheduleErrors))
			const names = yield* memberNames(tenant.orgId)
			return { schedule: toScheduleRow(schedule, names) }
		}),
		render: (output) => ({
			title: "On-Call Schedule Created",
			blocks: scheduleBlocks(output.schedule),
			next: [doc.next("who_is_on_call", { schedule: output.schedule.id }, "who is on call now")],
		}),
	})
}
