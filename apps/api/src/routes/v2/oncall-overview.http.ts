import { HttpApiBuilder } from "effect/http-api"
import { CurrentTenant } from "@maple/domain/http"
import type { V2OnCallOverview, V2OnCallOverviewShift } from "@maple/domain/http/v2"
import { MapleApiV2, timestamp } from "@maple/domain/http/v2"
import { Array as Arr, DateTime, Effect, String as Str } from "effect"
import {
	OnCallSchedulesService,
	type OnCallOverviewSchedule,
} from "@maple/backend/services/alerts/OnCallSchedulesService"

type OnCallShift = OnCallOverviewSchedule["shifts"][number]

const iso = (ms: number) => timestamp(DateTime.formatIso(DateTime.makeUnsafe(ms)))

const toV2Shift = (shift: OnCallShift): V2OnCallOverviewShift => ({
	user_id: shift.userId,
	starts_at: iso(shift.startMs),
	ends_at: iso(shift.endMs),
	is_override: shift.source.kind === "override",
})

/** "Weekly, hands off Mon 09:00": one line for a schedule's header. Several layers are only counted. */
const rotationSummary = (layers: OnCallOverviewSchedule["layers"]): string => {
	const [only, ...more] = layers
	if (only === undefined) return "No layers"
	if (more.length > 0) return `${layers.length} layers`
	const rotation = only.rotation
	switch (rotation.kind) {
		case "daily":
			return `Daily, hands off ${rotation.handoffTime}`
		case "weekly":
			return `Weekly, hands off ${Str.capitalize(rotation.handoffWeekday)} ${rotation.handoffTime}`
		case "custom":
			return rotation.lengthHours % 24 === 0
				? `Every ${rotation.lengthHours / 24} ${rotation.lengthHours === 24 ? "day" : "days"}`
				: `Every ${rotation.lengthHours} hours`
	}
}

/** The one document both routes serve: the app's under `/v2/alerts`, a widget's under its own scope. */
const overviewOf = (schedules: OnCallSchedulesService["Service"]) =>
	Effect.gen(function* () {
		const tenant = yield* CurrentTenant.Context
		const overview = yield* schedules.overview(tenant.orgId, tenant.userId)
		return {
			object: "oncall_overview",
			generated_at: iso(overview.nowMs),
			organization_id: tenant.orgId,
			user_id: tenant.userId,
			schedule_window_ends_at: iso(overview.scheduleHorizonMs),
			schedules: Arr.map(overview.schedules, (schedule) => {
				// Whoever starts once the current shift is over; with nobody on call, whoever is first.
				const after = schedule.now === null ? overview.nowMs : schedule.now.endMs
				const next = Arr.findFirst(schedule.shifts, (shift) => shift.startMs >= after)
				return {
					id: schedule.id,
					name: schedule.name,
					time_zone: schedule.timeZone,
					rotation_summary: rotationSummary(schedule.layers),
					on_call_now: schedule.now === null ? null : toV2Shift(schedule.now),
					next: next._tag === "Some" ? toV2Shift(next.value) : null,
					shifts: Arr.map(schedule.shifts, toV2Shift),
					coverage_gaps: Arr.map(schedule.gaps, (gap) => ({
						starts_at: iso(gap.startMs),
						ends_at: iso(gap.endMs),
					})),
				}
			}),
			my_shifts: Arr.map(overview.myShifts, (mine) => ({
				schedule_id: mine.scheduleId,
				schedule_name: mine.scheduleName,
				starts_at: iso(mine.shift.startMs),
				ends_at: iso(mine.shift.endMs),
				is_override: mine.shift.source.kind === "override",
			})),
			people: Arr.map(overview.people, (person) => ({ user_id: person.userId, name: person.name })),
		} satisfies V2OnCallOverview
	})

export const HttpV2OnCallOverviewLive = HttpApiBuilder.group(MapleApiV2, "oncallOverview", (handlers) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		return handlers.handle("retrieve", () =>
			overviewOf(schedules).pipe(Effect.withSpan("HttpV2OnCallOverview.retrieve")),
		)
	}),
)

export const HttpV2WidgetOnCallLive = HttpApiBuilder.group(MapleApiV2, "widgetOnCall", (handlers) =>
	Effect.gen(function* () {
		const schedules = yield* OnCallSchedulesService
		return handlers.handle("retrieve", () =>
			overviewOf(schedules).pipe(Effect.withSpan("HttpV2WidgetOnCall.retrieve")),
		)
	}),
)
