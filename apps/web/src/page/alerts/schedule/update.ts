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
import { isoMs, msIso } from "../shared/time"

type Return = PageReturn<Model, Message>
type ScheduleRoute = Extract<AppRoute, { readonly _tag: "AlertsSchedule" }>

export const OVERRIDE_DIALOG_ID = "schedule-override"
export const DELETE_OVERRIDE_DIALOG_ID = "schedule-delete-override"

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

/**
 * The shifts are read this far past either edge: the API clips shifts to the range it is asked,
 * so a shift crossing the week's edge keeps its real bounds (a custom layer's longest is 14 days).
 */
export const SHIFT_READ_MARGIN_MS = 14 * 86_400_000

/** The range the shifts are read over: the calendar's, widened by the margin. */
export const readRangeOf = (model: Model): Option.Option<Readonly<{ fromMs: number; toMs: number }>> =>
	Option.map(rangeOf(model), ({ fromMs, toMs }) => ({
		fromMs: fromMs - SHIFT_READ_MARGIN_MS,
		toMs: toMs + SHIFT_READ_MARGIN_MS,
	}))

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
		overrideDraft: { userId: "", startsAt: "", endsAt: "", startMs: null, endMs: null },
		isShowingOverrideErrors: false,
		isCreatingOverride: false,
		overrideError: null,
		overrideOpenCount: 0,
		deletingOverrideId: null,
		confirmDeleteOverrideId: null,
		deleteOverrideDialog: Dialog.init(DELETE_OVERRIDE_DIALOG_ID, "alert-dialog"),
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

/**
 * The shifts of the range on screen; a new range or a write reads them again. A tick's `Load`
 * leaves a failure on screen: only Try again asks again.
 */
const requestShifts = (model: Model, context: PageContext, mode: Keyed.ReadMode): Return => {
	const scheduleId = model.scheduleId
	return Option.match(readRangeOf(model), {
		onNone: () => ({ model }),
		onSome: ({ fromMs, toMs }) => {
			if (scheduleId === null) return { model }
			const key = requestKey(context.orgId, "oncallSchedules.shifts", { id: scheduleId, fromMs, toMs })
			const requested =
				mode === "Supersede"
					? Keyed.requestFor(model.shifts, key, mode)
					: Keyed.requestKeepingFailure(model.shifts, key, mode)
			return Option.match(requested, {
				onNone: () => ({ model }),
				onSome: (shifts) => ({
					model: { ...model, shifts },
					commands: [FetchShifts({ key: shifts.key, scheduleId, fromMs, toMs })],
				}),
			})
		},
	})
}

/** The schedule read again: its header's "on call now" moves with a handoff or an override. */
const refreshSchedule = (model: Model, context: PageContext): Return => {
	const scheduleId = model.scheduleId
	if (scheduleId === null) return { model }
	const schedule = Keyed.supersede(
		model.schedule,
		requestKey(context.orgId, "oncallSchedules.retrieve", { id: scheduleId }),
	)
	return { model: { ...model, schedule }, commands: [FetchSchedule({ key: schedule.key, scheduleId })] }
}

/** An override write: the overrides, the shifts and the schedule's "on call now" are read again. */
const refreshOverrides = (model: Model, context: PageContext): Return => {
	const scheduleId = model.scheduleId
	if (scheduleId === null) return { model }
	const key = requestKey(context.orgId, "oncallSchedules.listOverrides", { id: scheduleId })
	const overrides = Keyed.supersede(model.overrides, key)
	const shifts = requestShifts({ ...model, overrides }, context, "Supersede")
	const schedule = refreshSchedule(shifts.model, context)
	return {
		model: schedule.model,
		commands: [
			FetchOverrides({ key: overrides.key, scheduleId }),
			...(shifts.commands ?? []),
			...(schedule.commands ?? []),
		],
	}
}

/** With nobody on call there is no handoff to wait for, so the header is read again every 5 minutes. */
const SCHEDULE_MAX_AGE_MS = 5 * 60_000

/** The header's shift has handed off, or a gap has gone unchecked too long. */
export const isScheduleStale = (model: Model, nowMs: number): boolean =>
	AsyncData.isSuccess(model.schedule.data) &&
	Option.exists(scheduleOf(model), (schedule) =>
		Option.match(Option.fromNullishOr(schedule.on_call_now), {
			onSome: (now) => isoMs(now.ends_at) <= nowMs,
			onNone: () => nowMs - (model.schedule.updatedAtMs ?? nowMs) >= SCHEDULE_MAX_AGE_MS,
		}),
	)

const clockRead = (model: Model, context: PageContext, nowMs: number): Return => {
	const shifts = requestShifts({ ...model, nowMs }, context, "Load")
	if (!isScheduleStale(shifts.model, nowMs)) return shifts
	const schedule = refreshSchedule(shifts.model, context)
	return { model: schedule.model, commands: [...(shifts.commands ?? []), ...(schedule.commands ?? [])] }
}

const decodeUserId = Schema.decodeUnknownOption(UserId)

/** What is wrong with the override form, or none. */
export const overrideIssue = (
	draft: OverrideDraft,
	timeZone: string,
	nowMs: number,
): Option.Option<string> => {
	const start = draft.startMs === null ? localInputMs(draft.startsAt, timeZone) : Option.some(draft.startMs)
	const end = draft.endMs === null ? localInputMs(draft.endsAt, timeZone) : Option.some(draft.endMs)
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
						draft.startMs === null
							? localInputMs(draft.startsAt, timeZone)
							: Option.some(draft.startMs),
						draft.endMs === null
							? localInputMs(draft.endsAt, timeZone)
							: Option.some(draft.endMs),
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
		onSome: (schedule) => {
			// An override cannot lie wholly in the past: one over a running shift starts now.
			const fromMs = Math.max(startMs, model.nowMs ?? startMs)
			return liftDialog(
				{
					...model,
					overrideDraft: {
						userId: "",
						startsAt: localInputOf(fromMs, schedule.time_zone),
						endsAt: localInputOf(endMs, schedule.time_zone),
						startMs: fromMs,
						endMs,
					},
					isShowingOverrideErrors: false,
					overrideError: null,
					overrideOpenCount: model.overrideOpenCount + 1,
				},
				Dialog.open(model.overrideDialog),
			)
		},
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

/** Runs the delete confirmation's update; `Closed` forgets the target. */
const updateDeleteDialog = (model: Model, step: ReturnType<typeof Dialog.update>): Return => ({
	model: {
		...model,
		deleteOverrideDialog: step.model,
		confirmDeleteOverrideId: step.outMessage?._tag === "Closed" ? null : model.confirmDeleteOverrideId,
	},
	commands: FoldkitCommand.mapMessages(step.commands ?? [], (message) =>
		Message.GotDeleteOverrideDialogMessage({ message }),
	),
})

const toast = (type: "success" | "error", title: string, description = "") =>
	PageOutMessage.RequestedToast({ type, title, description })

const moveWeek = (model: Model, context: PageContext, weekOffset: number): Return =>
	requestShifts({ ...model, weekOffset }, context, "Load")

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		ReadClock: ({ nowMs }) => clockRead(model, context, nowMs),
		CompletedFetchSchedule: ({ key, readAtMs, result }) =>
			requestShifts(
				{ ...model, schedule: Keyed.accept(model.schedule, key, result, readAtMs) },
				context,
				"Load",
			),
		ClickedRetryShifts: () => requestShifts(model, context, "Supersede"),
		CompletedFetchShifts: ({ key, result }) => ({
			model: { ...model, shifts: Keyed.accept(model.shifts, key, result) },
		}),
		CompletedFetchOverrides: ({ key, result }) => ({
			model: { ...model, overrides: Keyed.accept(model.overrides, key, result) },
		}),
		CompletedFetchMembers: ({ result }) =>
			Result.match(result, {
				onSuccess: (members) => ({ model: { ...model, members } }),
				// A failed read keeps names neutral ("Member") rather than calling everyone a former member.
				onFailure: () => ({ model }),
			}),
		CompletedFetchSession: ({ orgId, grants }) =>
			orgId === context.orgId ? { model: { ...model, grants } } : { model },
		ClickedRetry: () => refreshSchedule(model, context),
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
			model: { ...model, overrideDraft: { ...model.overrideDraft, startsAt: value, startMs: null } },
		}),
		ChangedOverrideEnd: ({ value }) => ({
			model: { ...model, overrideDraft: { ...model.overrideDraft, endsAt: value, endMs: null } },
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
			model.deletingOverrideId !== null || !canManage(model)
				? { model }
				: updateDeleteDialog(
						{ ...model, confirmDeleteOverrideId: overrideId },
						Dialog.open(model.deleteOverrideDialog),
					),
		ClickedConfirmDeleteOverride: () => {
			const overrideId = model.confirmDeleteOverrideId
			return overrideId === null || model.deletingOverrideId !== null || model.scheduleId === null
				? { model }
				: {
						model: { ...model, deletingOverrideId: overrideId },
						commands: [DeleteOverride({ scheduleId: model.scheduleId, overrideId })],
					}
		},
		GotDeleteOverrideDialogMessage: ({ message: child }) =>
			// The dialog ignores dismissal while the delete is in flight.
			model.deletingOverrideId !== null
				? { model }
				: updateDeleteDialog(model, Dialog.update(model.deleteOverrideDialog, child)),
		CompletedDeleteOverride: ({ result }) => {
			const settled = { ...model, deletingOverrideId: null }
			const closed = updateDeleteDialog(settled, Dialog.close(settled.deleteOverrideDialog))
			// Either way the list is read again: a 404 means someone else already removed it.
			const refreshed = refreshOverrides(closed.model, context)
			return {
				model: refreshed.model,
				commands: [...(closed.commands ?? []), ...(refreshed.commands ?? [])],
				outMessage: Result.match(result, {
					onSuccess: () => toast("success", "Override deleted"),
					onFailure: (failure) => toast("error", "Couldn't delete the override", failure.message),
				}),
			}
		},
	})

export const overridesOf = (model: Model) =>
	Option.getOrElse(AsyncData.getData(model.overrides.data), () => [])
