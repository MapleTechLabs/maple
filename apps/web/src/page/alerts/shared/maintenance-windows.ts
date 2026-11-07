import { AlertMaintenanceWindowId, type MaintenanceWeekday } from "@maple/domain/http"
import {
	AlertMaintenanceWindowPublicId,
	encodePublicId,
	PublicIdPrefixes,
	type V2AlertMaintenanceWindow,
	V2AlertMaintenanceWindowCreateParams,
	V2AlertMaintenanceWindowUpdateParams,
	type V2MaintenanceSchedule,
} from "@maple/domain/http/v2"
import { Effect, Option, Ref, Schema, Array as Arr, String as Str } from "effect"
import { formatTimeInTimezone } from "@maple/web-data/lib/timezone-format"
import { toLoadFailure } from "@maple/views/data/load-failure"
import { MapleApiV2Client } from "../../../platform/api-clients"
import { alertsHref } from "./links"
import { formatSilenceTime } from "./silences"
import { isoMs } from "./time"

// Maintenance windows: the hub's reads and writes, and how a window's schedule reads in a row.

export const WINDOW_LIST_LIMIT = 100

/** Pages read at most per list, far past what an org holds. */
const MAX_LIST_PAGES = 20

type Page<A> = Readonly<{ data: ReadonlyArray<A>; has_more: boolean; next_cursor: string | null }>

/** Every row of a cursor-paginated list, following `next_cursor` until `has_more` is false. */
const readAllPages = <A, E, R>(readPage: (cursor: string | null) => Effect.Effect<Page<A>, E, R>) =>
	Effect.gen(function* () {
		const progress = yield* Ref.make<{ rows: ReadonlyArray<A>; cursor: string | null; pages: number }>({
			rows: [],
			cursor: null,
			pages: 0,
		})
		const step = Effect.gen(function* () {
			const { rows, cursor, pages } = yield* Ref.get(progress)
			const page = yield* readPage(cursor)
			const next = page.has_more ? page.next_cursor : null
			yield* Ref.set(progress, { rows: [...rows, ...page.data], cursor: next, pages: pages + 1 })
			return next !== null && pages + 1 < MAX_LIST_PAGES
		})
		yield* step.pipe(Effect.repeat({ while: (hasMore) => hasMore }))
		return (yield* Ref.get(progress)).rows
	})

const cursorQuery = (cursor: string | null) => (cursor === null ? undefined : { cursor })

export const listMaintenanceWindows = Effect.gen(function* () {
	const client = yield* MapleApiV2Client
	return yield* readAllPages((cursor) =>
		client.alertMaintenanceWindows.list({ query: { limit: WINDOW_LIST_LIMIT, ...cursorQuery(cursor) } }),
	)
}).pipe(Effect.mapError(toLoadFailure))

/** Every silence one window wrote, filtered by the API rather than in the first page. */
export const listWindowSilences = (id: AlertMaintenanceWindowId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* readAllPages((cursor) =>
			client.alertSilences.list({
				query: { limit: WINDOW_LIST_LIMIT, maintenance_window_id: id, ...cursorQuery(cursor) },
			}),
		)
	}).pipe(Effect.mapError(toLoadFailure))

/** A new window in full, or only the fields an edit changed. */
export const SaveRequest = Schema.Union([
	Schema.TaggedStruct("Create", { payload: V2AlertMaintenanceWindowCreateParams }),
	Schema.TaggedStruct("Update", {
		id: AlertMaintenanceWindowId,
		payload: V2AlertMaintenanceWindowUpdateParams,
	}),
])
export type SaveRequest = typeof SaveRequest.Type

export const saveMaintenanceWindow = (request: SaveRequest) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return request._tag === "Create"
			? yield* client.alertMaintenanceWindows.create({ payload: request.payload })
			: yield* client.alertMaintenanceWindows.update({
					params: { id: request.id },
					payload: request.payload,
				})
	}).pipe(Effect.mapError(toLoadFailure))

export const updateMaintenanceWindow = (
	id: AlertMaintenanceWindowId,
	payload: V2AlertMaintenanceWindowUpdateParams,
) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		return yield* client.alertMaintenanceWindows.update({ params: { id }, payload })
	}).pipe(Effect.mapError(toLoadFailure))

export const deleteMaintenanceWindow = (id: AlertMaintenanceWindowId) =>
	Effect.gen(function* () {
		const client = yield* MapleApiV2Client
		yield* client.alertMaintenanceWindows.delete({ params: { id } })
	}).pipe(Effect.mapError(toLoadFailure))

/** The `mw_…` id a link carries. */
export const windowPublicId = (id: AlertMaintenanceWindowId): string =>
	encodePublicId(PublicIdPrefixes.alertMaintenanceWindow, id)

/** A `window` search param read back as the window's id; none when it is not one. */
export const windowIdOfParam = (raw: string | undefined): Option.Option<AlertMaintenanceWindowId> =>
	raw === undefined ? Option.none() : Schema.decodeOption(AlertMaintenanceWindowPublicId)(raw)

/** The Silences tab showing only this window's occurrences. */
export const windowSilencesHref = (id: AlertMaintenanceWindowId): string =>
	alertsHref({ tab: "silences", window: windowPublicId(id) })

export const WEEKDAYS: ReadonlyArray<{ value: MaintenanceWeekday; label: string }> = [
	{ value: "mon", label: "Mon" },
	{ value: "tue", label: "Tue" },
	{ value: "wed", label: "Wed" },
	{ value: "thu", label: "Thu" },
	{ value: "fri", label: "Fri" },
	{ value: "sat", label: "Sat" },
	{ value: "sun", label: "Sun" },
]

/** "Mon and Thu", "Mon, Wed and Fri", "every day", in week order. */
export const formatDays = (days: ReadonlyArray<MaintenanceWeekday>): string => {
	const labels = Arr.map(
		Arr.filter(WEEKDAYS, (day) => days.includes(day.value)),
		(day) => day.label,
	)
	if (labels.length === WEEKDAYS.length) return "every day"
	const last = labels[labels.length - 1]
	return labels.length <= 1 || last === undefined
		? Arr.join(labels, "")
		: `${Arr.join(labels.slice(0, -1), ", ")} and ${last}`
}

/** "2h", "1h 30m", "45m", "7d". */
export const formatDurationMinutes = (minutes: number): string => {
	const days = Math.floor(minutes / 1440)
	const hours = Math.floor((minutes % 1440) / 60)
	const rest = minutes % 60
	const parts = [
		...(days > 0 ? [`${days}d`] : []),
		...(hours > 0 ? [`${hours}h`] : []),
		...(rest > 0 ? [`${rest}m`] : []),
	]
	return parts.length === 0 ? "0m" : Arr.join(parts, " ")
}

/** A weekly `HH:MM` start drawn by the same formatter as every other time on the page. */
export const formatWallClock = (startTime: string): string => {
	const parts = Arr.map(Str.split(":")(startTime), Number)
	const at = (index: number) => Option.getOrElse(Arr.get(parts, index), () => 0)
	return formatTimeInTimezone(Date.UTC(2000, 0, 1, at(0), at(1)), { timeZone: "UTC", withSeconds: false })
}

/** "Weekly, Mon and Thu at 02:00 for 2h (Europe/Berlin)" or "Once, Nov 7, 22:00 to Nov 8, 01:00". */
export const scheduleSummary = (schedule: V2MaintenanceSchedule, nowMs: number, timeZone: string): string =>
	schedule.type === "weekly"
		? `Weekly, ${formatDays(schedule.days)} at ${formatWallClock(schedule.start_time)} for ${formatDurationMinutes(schedule.duration_minutes)} (${schedule.time_zone})`
		: `Once, ${formatSilenceTime(isoMs(schedule.starts_at), nowMs, timeZone)} to ${formatSilenceTime(isoMs(schedule.ends_at), nowMs, timeZone)}`

/** The window's occurrence as the list reads it now. */
export type OccurrenceState =
	| Readonly<{ _tag: "Running"; endsAtMs: number }>
	| Readonly<{ _tag: "Next"; startsAtMs: number; endsAtMs: number }>
	| Readonly<{ _tag: "None" }>

export const occurrenceStateAt = (window: V2AlertMaintenanceWindow, nowMs: number): OccurrenceState => {
	const next = window.next_occurrence
	if (next === null) return { _tag: "None" }
	const startsAtMs = isoMs(next.starts_at)
	const endsAtMs = isoMs(next.ends_at)
	if (endsAtMs <= nowMs) return { _tag: "None" }
	return startsAtMs <= nowMs ? { _tag: "Running", endsAtMs } : { _tag: "Next", startsAtMs, endsAtMs }
}

/** "Running until 15:00", "Next Nov 8, 02:00", "No more occurrences", or "Disabled". */
export const occurrenceText = (window: V2AlertMaintenanceWindow, nowMs: number, timeZone: string): string => {
	if (!window.enabled) return "Disabled"
	const state = occurrenceStateAt(window, nowMs)
	switch (state._tag) {
		case "Running":
			return `Running until ${formatSilenceTime(state.endsAtMs, nowMs, timeZone)}`
		case "Next":
			return `Next ${formatSilenceTime(state.startsAtMs, nowMs, timeZone)}`
		case "None":
			return "No more occurrences"
	}
}

/** A one-off window whose end has passed: it can never run again. */
export const isEndedOnce = (window: V2AlertMaintenanceWindow, nowMs: number): boolean =>
	window.schedule.type === "once" && isoMs(window.schedule.ends_at) <= nowMs

/** Baseline exclusion only applies when the window names a service or an environment. */
export const excludesBaselines = (window: V2AlertMaintenanceWindow): boolean =>
	window.exclude_from_baselines &&
	(window.matchers.services ?? []).length + (window.matchers.environments ?? []).length > 0
