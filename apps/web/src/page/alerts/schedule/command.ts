import { OnCallOverrideId, OnCallScheduleId } from "@maple/domain/http"
import { V2OnCallOverrideCreateParams } from "@maple/domain/http/v2"
import { Clock, Effect, Schema } from "effect"
import { Command } from "foldkit"
import { readGrants } from "../../../data/session-tenant"
import {
	createOverride,
	deleteOverride,
	listOverrides,
	listShifts,
	retrieveOnCallSchedule,
} from "../shared/oncall-schedules"
import { listOrgMembers } from "../shared/org-members"
import { Message } from "./message"

export const ReadScheduleClock = Command.define("ReadScheduleClock", {
	messages: [Message.ReadClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.ReadClock({ nowMs })),
})

export const FetchSchedule = Command.define("FetchOnCallSchedule", {
	args: { key: Schema.String, scheduleId: OnCallScheduleId },
	messages: [Message.CompletedFetchSchedule],
	execute: ({ key, scheduleId }) =>
		retrieveOnCallSchedule(scheduleId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchSchedule({ key, result })),
		),
})

export const FetchShifts = Command.define("FetchOnCallShifts", {
	args: { key: Schema.String, scheduleId: OnCallScheduleId, fromMs: Schema.Number, toMs: Schema.Number },
	messages: [Message.CompletedFetchShifts],
	execute: ({ key, scheduleId, fromMs, toMs }) =>
		listShifts(scheduleId, fromMs, toMs).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchShifts({ key, result })),
		),
})

export const FetchOverrides = Command.define("FetchOnCallOverrides", {
	args: { key: Schema.String, scheduleId: OnCallScheduleId },
	messages: [Message.CompletedFetchOverrides],
	execute: ({ key, scheduleId }) =>
		listOverrides(scheduleId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedFetchOverrides({ key, result })),
		),
})

export const FetchScheduleMembers = Command.define("FetchScheduleMembers", {
	messages: [Message.CompletedFetchMembers],
	execute: listOrgMembers.pipe(
		Effect.result,
		Effect.map((result) => Message.CompletedFetchMembers({ result })),
	),
})

export const FetchScheduleSession = Command.define("FetchScheduleSession", {
	args: { orgId: Schema.String },
	messages: [Message.CompletedFetchSession],
	execute: ({ orgId }) =>
		Effect.map(readGrants, (grants) => Message.CompletedFetchSession({ orgId, grants })),
})

export const CreateOverride = Command.define("CreateOnCallOverride", {
	args: { openCount: Schema.Number, scheduleId: OnCallScheduleId, payload: V2OnCallOverrideCreateParams },
	messages: [Message.CompletedCreateOverride],
	execute: ({ openCount, scheduleId, payload }) =>
		createOverride(scheduleId, payload).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedCreateOverride({ openCount, result })),
		),
})

export const DeleteOverride = Command.define("DeleteOnCallOverride", {
	args: { scheduleId: OnCallScheduleId, overrideId: OnCallOverrideId },
	messages: [Message.CompletedDeleteOverride],
	execute: ({ scheduleId, overrideId }) =>
		deleteOverride(scheduleId, overrideId).pipe(
			Effect.result,
			Effect.map((result) => Message.CompletedDeleteOverride({ overrideId, result })),
		),
})
