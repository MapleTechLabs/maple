import type { McpToolRegistrar } from "./types"
import { Array as Arr, Effect, Schema } from "effect"
import { ListOnCallSchedulesOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { formatLayers, formatOnCallNow, memberNames, toScheduleRow } from "../lib/oncall-schedules"
import { doc } from "../lib/tool-doc"

export function registerListOnCallSchedulesTool(server: McpToolRegistrar) {
	server.define({
		name: "list_oncall_schedules",
		title: "List On-Call Schedules",
		description:
			"List on-call schedules: layered rotations in a time zone that say who is on call when, with overrides on top. " +
			"Shows each schedule's layers, participants and who is on call right now. Ask about one instant with who_is_on_call.",
		parameters: Schema.Struct({}),
		output: ListOnCallSchedulesOutput,
		hints: { readOnly: true },
		phrases: ["Listing on-call schedules"],
		handler: Effect.fn("McpTool.listOnCallSchedules")(function* () {
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			const result = yield* schedules
				.list(tenant.orgId)
				.pipe(Effect.mapError(toMcpHttpError("list_oncall_schedules")))
			const names =
				result.schedules.length === 0 ? new Map<string, string>() : yield* memberNames(tenant.orgId)
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"result.rowCount": result.schedules.length,
			})
			return {
				schedules: Arr.map(result.schedules, (schedule) => toScheduleRow(schedule, names)),
				total: result.schedules.length,
			}
		}),
		render: (output) => ({
			title: "On-Call Schedules",
			...(output.schedules.length === 0
				? {
						empty: {
							message:
								"No on-call schedules yet. Create one with create_oncall_schedule from your workspace members.",
						},
					}
				: undefined),
			blocks: Arr.flatMap(output.schedules, (schedule) => [
				doc.heading(`${schedule.name} (${schedule.id})`),
				doc.text(`${schedule.timeZone}: ${formatOnCallNow(schedule)}\n${formatLayers(schedule)}`),
			]),
			next: Arr.take(
				Arr.map(output.schedules, (schedule) =>
					doc.next(
						"who_is_on_call",
						{ schedule: schedule.id },
						`who is on call for ${schedule.name}`,
					),
				),
				3,
			),
		}),
	})
}
