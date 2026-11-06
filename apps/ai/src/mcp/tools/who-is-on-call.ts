import type { McpToolRegistrar } from "./types"
import { Array as Arr, Clock, Effect, Option, Schema } from "effect"
import { parseWarehouseDateTime } from "@maple/query-engine"
import { ONCALL_LOOKAROUND_MS } from "@maple/domain/http"
import { WhoIsOnCallOutput } from "@maple/domain/mcp-outputs"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { CurrentMcpTenant } from "../lib/query-warehouse"
import { toMcpHttpError } from "../lib/map-http-error"
import { isoMs, memberNames, personLabel, resolveSchedule, toShiftRow } from "../lib/oncall-schedules"
import * as P from "../lib/params"
import { doc } from "../lib/tool-doc"

/** How far ahead the next shift is looked for. */
const NEXT_SHIFT_HORIZON_MS = 14 * 86_400_000

export function registerWhoIsOnCallTool(server: McpToolRegistrar) {
	server.define({
		name: "who_is_on_call",
		title: "Who Is On Call",
		description:
			"Who is on call for a schedule at an instant (default now), what put them there (a layer or an override), when their shift ends and who is next. " +
			"Schedules from list_oncall_schedules, by id or name.",
		parameters: Schema.Struct({
			schedule: P.text("On-call schedule: its UUID, its REST id (onc_…) or its name"),
			at: P.optionalTimestamp("The instant to ask about (default now)"),
		}),
		output: WhoIsOnCallOutput,
		hints: { readOnly: true },
		phrases: ["Checking who is on call"],
		handler: Effect.fn("McpTool.whoIsOnCall")(function* (params) {
			const tenant = yield* CurrentMcpTenant
			const schedules = yield* OnCallSchedulesService
			const schedule = yield* resolveSchedule(
				tenant.orgId,
				params.schedule,
				"schedule",
				"who_is_on_call",
			)
			const atMs =
				params.at === undefined ? yield* Clock.currentTimeMillis : parseWarehouseDateTime(params.at)
			const toError = Effect.mapError(toMcpHttpError("who_is_on_call"))
			const current = yield* schedules.onCallAt(tenant.orgId, schedule.id, atMs).pipe(toError)
			const nextFrom = current.shift === null ? atMs : isoMs(current.shift.endsAt)
			// A shift that ends at the lookaround edge was clamped there, not handed off: the
			// "next" one would only be the same shift continuing.
			const clamped = nextFrom >= atMs + ONCALL_LOOKAROUND_MS
			const upcoming = clamped
				? null
				: yield* schedules
						.shifts(tenant.orgId, schedule.id, nextFrom, nextFrom + NEXT_SHIFT_HORIZON_MS)
						.pipe(
							Effect.catchTag("@maple/http/errors/AlertValidationError", () =>
								Effect.succeed(null),
							),
							toError,
						)
			const next =
				upcoming === null
					? Option.none()
					: Arr.findFirst(upcoming.final, (s) => isoMs(s.startsAt) >= nextFrom)
			const names = yield* memberNames(tenant.orgId)
			yield* Effect.annotateCurrentSpan({
				orgId: tenant.orgId,
				"maple.oncall.schedule_id": schedule.id,
			})
			return {
				scheduleId: schedule.id,
				scheduleName: schedule.name,
				timeZone: schedule.timeZone,
				at: current.at,
				onCall: current.shift === null ? null : toShiftRow(current.shift, schedule.layers, names),
				next: Option.match(next, {
					onNone: () => null,
					onSome: (shift) => toShiftRow(shift, schedule.layers, names),
				}),
			}
		}),
		render: (output) => {
			const why = (shift: NonNullable<typeof output.onCall>) =>
				shift.source === "override" ? "an override" : `layer "${shift.layerName ?? "?"}"`
			return {
				title: `On Call: ${output.scheduleName}`,
				blocks: [
					doc.text(
						output.onCall === null
							? `Nobody is on call for ${output.scheduleName} at ${output.at}.`
							: `${personLabel(output.onCall.user)} is on call for ${output.scheduleName} at ${output.at}, through ${why(output.onCall)}, from ${output.onCall.startsAt} until ${output.onCall.endsAt}.`,
					),
					doc.fields([
						["Schedule", `${output.scheduleName} (${output.scheduleId})`],
						["Time zone", output.timeZone],
						[
							"Next",
							output.next === null
								? output.onCall === null
									? "nobody within two weeks"
									: "no handoff within two weeks"
								: `${personLabel(output.next.user)} from ${output.next.startsAt} until ${output.next.endsAt}`,
						],
					]),
				],
				next: [doc.next("list_oncall_schedules", {}, "every schedule and its layers")],
			}
		},
	})
}
