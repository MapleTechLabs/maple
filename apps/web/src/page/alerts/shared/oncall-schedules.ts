import type { OnCallOverrideId, OnCallScheduleId } from "@maple/domain/http"
import {
	OnCallSchedulePublicId,
	type V2OnCallOverrideCreateParams,
	type V2OnCallSchedule,
	type V2OnCallScheduleCreateParams,
} from "@maple/domain/http/v2"
import { Effect, Option, Schema } from "effect"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { AppRoute, hrefOf } from "../../../route"
import type { AlertsScheduleNewSearch } from "../../../route/search"
import { isoMs, msIso } from "./time"

// On-call schedule reads and writes as Effects the pages' Commands wrap, their links, and how a
// shift's edges read.

/** An org holds at most 50 schedules, one v2 page. */
export const SCHEDULE_LIST_LIMIT = 50

/** 409 on delete while an escalation chain still pages the schedule. */
export const SCHEDULE_IN_USE_CODE = "oncall_schedule_in_use"

export const listOnCallSchedules = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	const page = yield* client.oncallSchedules.list({ query: { limit: SCHEDULE_LIST_LIMIT } })
	return page.data
}).pipe(Effect.mapError(toLoadFailure))

export const retrieveOnCallSchedule = (id: OnCallScheduleId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.oncallSchedules.retrieve({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Creates a schedule, or replaces `editingId`'s fields (overrides are kept). */
export const saveOnCallSchedule = (
	editingId: OnCallScheduleId | null,
	payload: V2OnCallScheduleCreateParams,
) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return editingId === null
			? yield* client.oncallSchedules.create({ payload })
			: yield* client.oncallSchedules.update({
					params: { id: editingId },
					payload: { ...payload, description: payload.description ?? null },
				})
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteOnCallSchedule = (id: OnCallScheduleId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.oncallSchedules.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** Each layer's shifts and the final ones over `[fromMs, toMs)`. */
export const listShifts = (id: OnCallScheduleId, fromMs: number, toMs: number) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.oncallSchedules.shifts({
			params: { id },
			query: { from: msIso(fromMs), to: msIso(toMs) },
		})
	}).pipe(Effect.mapError(toLoadFailure))

/** The overrides that have not ended yet, by start. */
export const listOverrides = (id: OnCallScheduleId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		const page = yield* client.oncallSchedules.listOverrides({ params: { id }, query: { limit: 100 } })
		return page.data
	}).pipe(Effect.mapError(toLoadFailure))

export const createOverride = (id: OnCallScheduleId, payload: V2OnCallOverrideCreateParams) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.oncallSchedules.createOverride({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteOverride = (id: OnCallScheduleId, overrideId: OnCallOverrideId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.oncallSchedules.deleteOverride({ params: { id, override_id: overrideId } })
	}).pipe(Effect.mapError(toLoadFailure))

// LINKS

const encodePublicId = Schema.encodeSync(OnCallSchedulePublicId)
const decodePublicId = Schema.decodeUnknownOption(OnCallSchedulePublicId)

/** The `onc_…` id in a URL as the internal id. */
export const scheduleIdFromUrl = (raw: string): Option.Option<OnCallScheduleId> => decodePublicId(raw)

export const scheduleHref = (id: OnCallScheduleId): string =>
	hrefOf(AppRoute.AlertsSchedule({ scheduleId: encodePublicId(id), search: {} }))

export const newScheduleHref = (search: typeof AlertsScheduleNewSearch.Type = {}): string =>
	hrefOf(AppRoute.AlertsScheduleNew({ search }))

export const editScheduleHref = (id: OnCallScheduleId): string =>
	newScheduleHref({ scheduleId: encodePublicId(id) })

export const oncallTabHref = (): string => hrefOf(AppRoute.Alerts({ search: { tab: "oncall" } }))

// FORMAT

const edgeFormatters = new Map<string, Intl.DateTimeFormat>()

/** "Mon 16 Nov, 09:00" on the wall clock of `timeZone`. */
export const formatShiftEdge = (ms: number, timeZone: string): string => {
	const cached = edgeFormatters.get(timeZone)
	const formatter =
		cached ??
		new Intl.DateTimeFormat("en-GB", {
			timeZone,
			weekday: "short",
			day: "numeric",
			month: "short",
			hour: "2-digit",
			minute: "2-digit",
			hourCycle: "h23",
		})
	if (cached === undefined) edgeFormatters.set(timeZone, formatter)
	return formatter.format(ms)
}

/** "in 45m", "in 5h 10m", "in 3d 4h"; "now" once it has passed. */
export const formatUntil = (nowMs: number, atMs: number): string => {
	const minutes = Math.round((atMs - nowMs) / 60_000)
	if (minutes <= 0) return "now"
	if (minutes < 60) return `in ${minutes}m`
	const hours = Math.floor(minutes / 60)
	if (hours < 24) return minutes % 60 === 0 ? `in ${hours}h` : `in ${hours}h ${minutes % 60}m`
	const days = Math.floor(hours / 24)
	return hours % 24 === 0 ? `in ${days}d` : `in ${days}d ${hours % 24}h`
}

/** When the current shift hands off, as epoch ms; none while nobody is on call. */
export const handoffMs = (schedule: V2OnCallSchedule): Option.Option<number> =>
	Option.map(Option.fromNullishOr(schedule.on_call_now), (now) => isoMs(now.ends_at))
