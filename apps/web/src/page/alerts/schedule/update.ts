import { MAX_ONCALL_OVERRIDE_MS, UserId } from "@maple/domain/http"
import type { V2OnCallOverrideCreateParams, V2OnCallSchedule } from "@maple/domain/http/v2"
import { Option, Result, Schema } from "effect"
import { AsyncData, Command as FoldkitCommand } from "foldkit"
import * as Keyed from "@maple/views/data/keyed"
import { requestKey } from "@maple/views/data/request-key"
import * as Dialog from "@maple/views/ui/dialog"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import type { AppRoute } from "../../../route"
import { type PageContext, PageOutMessage, type PageReturn } from "../../contract"
import { scheduleIdFromUrl } from "../shared/oncall-schedules"
import { localInputMs, localInputOf } from "../schedule-form/form"
import {
	CreateOverride,
	DeleteOverride,
	FetchOverrides,
	FetchSchedule,
	FetchScheduleMembers,
	FetchScheduleSession,
	FetchShifts,
	ReadScheduleClock,
} from "./command"
import { Message } from "./message"
import { canManage, type Model, type OverrideDraft } from "./model"
import { msIso } from "../shared/time"

type Return = PageReturn<Model, Message>
type ScheduleRoute = Extract<AppRoute, { readonly _tag: "AlertsSchedule" }>

export const OVERRIDE_DIALOG_ID = "schedule-override"

/** The calendar shows one week of the schedule zone's days, from today. */
export const CALENDAR_DAYS = 7

export const scheduleOf = (model: Model): Option.Option<V2OnCallSchedule> =>
	AsyncData.getData(model.schedule.data)

/** The calendar's range: whole days on the schedule's own clock. */
export const rangeOf = (model: Model): Option.Option<Readonly<{ fromMs: number; toMs: number }>> =>
	Option.flatMap(scheduleOf(model), (schedule) =>
		model.nowMs === null
			? Option.none()
			: Option.some({
					fromMs: zonedDayStart(model.nowMs, schedule.time_zone, model.weekOffset * CALENDAR_DAYS),
					toMs: zonedDayStart(
						model.nowMs,
						schedule.time_zone,
						(model.weekOffset + 1) * CALENDAR_DAYS,
					),
				}),
	)

export const init = (route: ScheduleRoute, context: PageContext): Return => {
	const scheduleId = Option.getOrNull(scheduleIdFromUrl(route.scheduleId))
	const model: Model = {
		rawScheduleId: route.scheduleId,
		scheduleId,
		nowMs: null,
		schedule: Keyed.idle(),
		weekOffset: 0,
		shifts: Keyed.idle(),
		overrides: Keyed.idle(),
		members: null,
		grants: [],
		overrideDialog: Dialog.init(OVERRIDE_DIALOG_ID, "dialog"),
		overrideDraft: { userId: "", startsAt: "", endsAt: "" },
		isShowingOverrideErrors: false,
		isCreatingOverride: false,
		overrideError: null,
		overrideOpenCount: 0,
		deletingOverrideId: null,
	}
	const common = [
		ReadScheduleClock(),
		FetchScheduleMembers(),
		FetchScheduleSession({ orgId: context.orgId }),
	]
	if (scheduleId === null) return { model, commands: common }
	const schedule = Keyed.supersede(
		model.schedule,
		requestKey(context.orgId, "oncallSchedules.retrieve", { id: scheduleId }),
	)
	const overrides = Keyed.supersede(
		model.overrides,
		requestKey(context.orgId, "oncallSchedules.listOverrides", { id: scheduleId }),
	)
	return {
		model: { ...model, schedule, overrides },
		commands: [
			...common,
			FetchSchedule({ key: schedule.key, scheduleId }),
			FetchOverrides({ key: overrides.key, scheduleId }),
		],
	}
}

/** The shifts of the range on screen; a new range or a write reads them again. */
const requestShifts = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const scheduleId = model.scheduleId
	return Option.match(rangeOf(model), {
		onNone: () => ({ model }),
		onSome: ({ fromMs, toMs }) => {
			if (scheduleId === null) return { model }
			const key = requestKey(context.orgId, "oncallSchedules.shifts", { id: scheduleId, fromMs, toMs })
			return Option.match(Keyed.requestFor(model.shifts, key, mode), {
				onNone: () => ({ model }),
				onSome: (shifts) => ({
					model: { ...model, shifts },
					commands: [FetchShifts({ key: shifts.key, scheduleId, fromMs, toMs })],
				}),
			})
		},
	})
}

const refreshOverrides = (model: Model, context: PageContext): Return => {
	const scheduleId = model.scheduleId
	if (scheduleId === null) return { model }
	const key = requestKey(context.orgId, "oncallSchedules.listOverrides", { id: scheduleId })
	const overrides = Keyed.supersede(model.overrides, key)
	const shifts = requestShifts({ ...model, overrides }, context, "Supersede")
	return {
		model: shifts.model,
		commands: [FetchOverrides({ key: overrides.key, scheduleId }), ...(shifts.commands ?? [])],
	}
}

const decodeUserId = Schema.decodeUnknownOption(UserId)

/** What is wrong with the override form, or none. */
export const overrideIssue = (
	draft: OverrideDraft,
	timeZone: string,
	nowMs: number,
): Option.Option<string> => {
	const start = localInputMs(draft.startsAt, timeZone)
	const end = localInputMs(draft.endsAt, timeZone)
	if (Option.isNone(decodeUserId(draft.userId))) return Option.some("Pick who covers the shift")
	if (Option.isNone(start) || Option.isNone(end))
		return Option.some("Pick when the override starts and ends")
	if (end.value <= start.value) return Option.some("End the override after it starts")
	if (end.value <= nowMs) return Option.some("End the override in the future")
	if (end.value - start.value > MAX_ONCALL_OVERRIDE_MS) return Option.some("Keep an override to 90 days")
	return Option.none()
}

const payloadOf = (
	draft: OverrideDraft,
	timeZone: string,
	nowMs: number,
): Option.Option<V2OnCallOverrideCreateParams> =>
	Option.isSome(overrideIssue(draft, timeZone, nowMs))
		? Option.none()
		: Option.flatMap(decodeUserId(draft.userId), (user_id) =>
				Option.flatMap(
					Option.all([
						localInputMs(draft.startsAt, timeZone),
						localInputMs(draft.endsAt, timeZone),
					]),
					([start, end]) =>
						Option.some({
							user_id,
							starts_at: msIso(start),
							ends_at: msIso(end),
						}),
				),
			)

const liftDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: { ...model, overrideDialog: step.model },
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotOverrideDialogMessage({ message }),
	),
})

/** Opens the override dialog over a range: a clicked shift's, or the next hour's. */
const openOverride = (model: Model, startMs: number, endMs: number): Return =>
	Option.match(scheduleOf(model), {
		onNone: () => ({ model }),
		onSome: (schedule) =>
			liftDialog(
				{
					...model,
					overrideDraft: {
						userId: "",
						// An override cannot lie wholly in the past: one over a running shift starts now.
						startsAt: localInputOf(Math.max(startMs, model.nowMs ?? startMs), schedule.time_zone),
						endsAt: localInputOf(endMs, schedule.time_zone),
					},
					isShowingOverrideErrors: false,
					overrideError: null,
					overrideOpenCount: model.overrideOpenCount + 1,
				},
				Dialog.open(model.overrideDialog),
			),
	})

const HOUR_MS = 3_600_000

const createOverride = (model: Model): Return => {
	const scheduleId = model.scheduleId
	return Option.match(scheduleOf(model), {
		onNone: () => ({ model }),
		onSome: (schedule) =>
			model.isCreatingOverride || scheduleId === null
				? { model }
				: Option.match(payloadOf(model.overrideDraft, schedule.time_zone, model.nowMs ?? 0), {
						onNone: () => ({ model: { ...model, isShowingOverrideErrors: true } }),
						onSome: (payload) => ({
							model: { ...model, isCreatingOverride: true, overrideError: null },
							commands: [
								CreateOverride({ openCount: model.overrideOpenCount, scheduleId, payload }),
							],
						}),
					}),
	})
}

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const moveWeek = (model: Model, context: PageContext, weekOffset: number): Return =>
	requestShifts({ ...model, weekOffset }, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => requestShifts({ ...model, nowMs }, context, "Load"),
		CompletedFetchSchedule: ({ key, result }) =>
			requestShifts({ ...model, schedule: Keyed.accept(model.schedule, key, result) }, context, "Load"),
		CompletedFetchShifts: ({ key, result }) => ({
			model: { ...model, shifts: Keyed.accept(model.shifts, key, result) },
		}),
		CompletedFetchOverrides: ({ key, result }) => ({
			model: { ...model, overrides: Keyed.accept(model.overrides, key, result) },
		}),
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members } }),
				onFailure: () => ({ model: { ...model, members: [] } }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants } } : { model },
		ClickedRetry: () => {
			const scheduleId = model.scheduleId
			if (scheduleId === null) return { model }
			const schedule = Keyed.supersede(
				model.schedule,
				requestKey(context.orgId, "oncallSchedules.retrieve", { id: scheduleId }),
			)
			return {
				model: { ...model, schedule },
				commands: [FetchSchedule({ key: schedule.key, scheduleId })],
			}
		},
		ClickedPreviousWeek: () => moveWeek(model, context, model.weekOffset - 1),
		ClickedNextWeek: () => moveWeek(model, context, model.weekOffset + 1),
		ClickedThisWeek: () => moveWeek(model, context, 0),
		ClickedShift: ({ startMs, endMs }) =>
			canManage(model) ? openOverride(model, startMs, endMs) : { model },
		ClickedNewOverride: () => {
			const now = model.nowMs ?? 0
			const start = Math.ceil(now / HOUR_MS) * HOUR_MS
			return openOverride(model, start, start + 8 * HOUR_MS)
		},
		GotOverrideDialogMessage: ({ message: child }) =>
			model.isCreatingOverride
				? { model }
				: liftDialog(model, Dialog.update(model.overrideDialog, child)),
		ChangedOverrideUser: ({ value }) => ({
			model: { ...model, overrideDraft: { ...model.overrideDraft, userId: value } },
		}),
		ChangedOverrideStart: ({ value }) => ({
			model: { ...model, overrideDraft: { ...model.overrideDraft, startsAt: value } },
		}),
		ChangedOverrideEnd: ({ value }) => ({
			model: { ...model, overrideDraft: { ...model.overrideDraft, endsAt: value } },
		}),
		ClickedCreateOverride: () => createOverride(model),
		CompletedCreateOverride: ({ openCount, result }) =>
			openCount !== model.overrideOpenCount
				? { model }
				: Result.match(result, {
						onSuccess: (): Return => {
							const closed = liftDialog(
								{ ...model, isCreatingOverride: false },
								Dialog.close(model.overrideDialog),
							)
							const refreshed = refreshOverrides(closed.model, context)
							return {
								model: refreshed.model,
								commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
								outMessage: toast("success", "Override created"),
							}
						},
						onFailure: (failure): Return => ({
							model: { ...model, isCreatingOverride: false, overrideError: failure.message },
						}),
					}),
		ClickedDeleteOverride: ({ overrideId }) =>
			model.deletingOverrideId !== null || model.scheduleId === null
				? { model }
				: {
						model: { ...model, deletingOverrideId: overrideId },
						commands: [DeleteOverride({ scheduleId: model.scheduleId, overrideId })],
					},
		CompletedDeleteOverride: ({ result }) => {
			const settled = { ...model, deletingOverrideId: null }
			return Result.match(result, {
				onSuccess: (): Return => ({
					...refreshOverrides(settled, context),
					outMessage: toast("success", "Override deleted"),
				}),
				onFailure: (failure): Return => ({
					model: settled,
					outMessage: toast("error", "Couldn't delete the override", failure.message),
				}),
			})
		},
	})

export const overridesOf = (model: Model) =>
	Option.getOrElse(AsyncData.getData(model.overrides.data), () => [])
