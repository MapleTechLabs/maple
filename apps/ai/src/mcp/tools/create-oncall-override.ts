import { McpInvalidInputError, type McpToolRegistrar } from "./types"
import { Effect, Schema } from "effect"
import { parseWarehouseDateTime, WarehouseTimeInput } from "@maple/query-engine"
import { OnCallOverrideCreateRequest } from "@maple/domain/http"
import { OnCallOverrideMutationOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import {
	createOverrideErrors,
	deleteScheduleErrors,
	memberNames,
	personLabel,
	toOverrideRow,
} from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

const decodeCreateRequest = Schema.decodeUnknownEffect(OnCallOverrideCreateRequest)
const timestamp = (meaning: string) =>
	Schema.String.annotate({ description: `${meaning}, UTC (YYYY-MM-DD HH:mm:ss or ISO 8601)` }).pipe(
		Schema.decodeTo(WarehouseTimeInput),
	)

export function registerCreateOnCallOverrideTool(server: McpToolRegistrar) {
	server.define({
		name: "create_oncall_override",
		title: "Create On-Call Override",
		description:
			"Put one workspace member on call for a window, over every layer of a schedule: a swap, cover for time off, a holiday. " +
			"At most 90 days, ending in the future. The newest overlapping override wins. Ids from list_oncall_schedules.",
		parameters: Schema.Struct({
			schedule_id: P.resourceId("oncallSchedule", "On-call schedule to override"),
			user_id: P.text("Maple user id (user_…) of the member who covers"),
			starts_at: timestamp("When the cover starts"),
			ends_at: timestamp("When the cover ends"),
		}),
		output: OnCallOverrideMutationOutput,
		hints: { readOnly: false, destructive: false, idempotent: false },
		phrases: ["Creating an on-call override"],
		handler: Effect.fn("McpTool.createOnCallOverride")(function* (params) {
			const scheduleId = yield* P.decodeResourceId("oncallSchedule", "schedule_id")(params.schedule_id)
			const request = yield* decodeCreateRequest({
				userId: params.user_id,
				startsAt: parseWarehouseDateTime(params.starts_at),
				endsAt: parseWarehouseDateTime(params.ends_at),
			}).pipe(
				Effect.mapError(
					(error) =>
						new McpInvalidInputError({
							message: `Invalid on-call override: ${String(error)}`,
							parameter: "user_id",
						}),
				),
			)
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* schedules.get(tenant.orgId, scheduleId).pipe(
				Effect.catchTags({
					"@maple/http/errors/OnCallScheduleNotFoundError":
						deleteScheduleErrors["@maple/http/errors/OnCallScheduleNotFoundError"],
					"@maple/http/errors/AlertPersistenceError":
						createOverrideErrors["@maple/http/errors/AlertPersistenceError"],
				}),
			)
			const override = yield* schedules
				.createOverride(tenant.orgId, tenant.userId, tenant.roles, scheduleId, request)
				.pipe(Effect.catchTags(createOverrideErrors))
			const names = yield* memberNames(tenant.orgId)
			return { scheduleName: schedule.name, override: toOverrideRow(override, names) }
		}),
		render: (output) => ({
			title: "On-Call Override Created",
			blocks: [
				doc.text(
					`${personLabel(output.override.user)} covers ${output.scheduleName} from ${output.override.startsAt} until ${output.override.endsAt}.`,
				),
				doc.fields([
					["ID", output.override.id],
					["REST id", output.override.publicId],
					["Schedule", output.override.scheduleId],
				]),
			],
			next: [
				doc.next(
					"who_is_on_call",
					{ schedule: output.override.scheduleId, at: output.override.startsAt },
					"check the cover",
				),
			],
		}),
	})
}
