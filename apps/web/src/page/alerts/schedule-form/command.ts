import { OnCallScheduleId } from "@maple/domain/http"
import { V2OnCallScheduleCreateParams } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import { browserZone, readSupportedTimeZones } from "../../../platform/time-zone"
import { retrieveOnCallSchedule, saveOnCallSchedule } from "../shared/oncall-schedules"
import { listOrgMembers } from "../shared/org-members"
import { Message } from "./message"

/** The browser's zone (a new schedule's default), the clock and the zones to pick from. */
export const ReadScheduleFormDefaults = Command.define("ReadScheduleFormDefaults", {
	messages: [Message.ReadDefaults],
	execute: Effect.map(
		Effect.all([browserZone, Clock.currentTimeMillis, readSupportedTimeZones]),
		([timeZone, nowMs, zones]) => Message.ReadDefaults({ timeZone, nowMs, zones }),
	),
})

export const FetchExistingSchedule = Command.define("FetchScheduleFormSchedule", {
	args: { key: Schema.String, scheduleId: OnCallScheduleId },
	messages: [Message.CompletedFetchExisting],
	execute: ({ key, scheduleId }) =>
		retrieveOnCallSchedule(scheduleId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchExisting({ key, result })),
		),
})

export const FetchScheduleFormMembers = Command.define("FetchScheduleFormMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: listOrgMembers.pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedFetchMembers({ result })),
	),
})

export const FetchScheduleFormSession = Command.define("FetchScheduleFormSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ orgId, grants })),
})

export const SaveSchedule = Command.define("SaveOnCallSchedule", {
	args: { editingId: Schema.NullOr(OnCallScheduleId), payload: V2OnCallScheduleCreateParams },
	messages: [Message.CompletedSave],
	execute: ({ editingId, payload }) =>
		saveOnCallSchedule(editingId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedSave({ result })),
		),
})
