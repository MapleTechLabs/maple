import { Array as Arr, Option, Order, Schema } from "effect"

// The sidebar's on-call pill: each schedule's current shift as the schedules list reads it, what
// the pill says, and when it asks again.

/** One schedule's current shift: who holds it until when, `null` in a gap. */
export const OnCallShift = Schema.Struct({
	scheduleName: Schema.String,
	userId: Schema.NullOr(Schema.String),
	endsAtMs: Schema.NullOr(Schema.Number),
})
export type OnCallShift = typeof OnCallShift.Type

/** The signed-in user, the zone they read times in, and every schedule of the org. */
export const OnCallSnapshot = Schema.Struct({
	userId: Schema.String,
	viewerTimeZone: Schema.String,
	shifts: Schema.Array(OnCallShift),
})
export type OnCallSnapshot = typeof OnCallSnapshot.Type

export type OnCallStatus =
	| Readonly<{ _tag: "NoSchedules" }>
	/** Every shift the user held has ended since the last read: hidden until the next one. */
	| Readonly<{ _tag: "Unknown" }>
	| Readonly<{ _tag: "NotOnCall" }>
	| Readonly<{
			_tag: "OnCall"
			scheduleName: string
			/** Other schedules the user also holds now. */
			otherSchedules: number
			until: string
	  }>

const untilFormatters = new Map<string, Intl.DateTimeFormat>()

/** "Mon 16 Nov, 09:00 CET" on the viewer's clock, naming the zone; built from parts, as ICU builds differ in the joiner. */
export const formatUntil = (ms: number, timeZone: string): string => {
	const cached = untilFormatters.get(timeZone)
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
			timeZoneName: "short",
		})
	if (cached === undefined) untilFormatters.set(timeZone, formatter)
	const parts = formatter.formatToParts(ms)
	const part = (type: Intl.DateTimeFormatPartTypes) =>
		Option.match(
			Arr.findFirst(parts, (candidate) => candidate.type === type),
			{ onNone: () => "", onSome: (found) => found.value },
		)
	return `${part("weekday")} ${part("day")} ${part("month")}, ${part("hour")}:${part("minute")} ${part("timeZoneName")}`
}

const byEnd = Order.mapInput(Order.Number, (shift: OnCallShift) => shift.endsAtMs ?? Number.POSITIVE_INFINITY)

const hasEnded = (shift: OnCallShift, nowMs: number): boolean =>
	shift.endsAtMs !== null && shift.endsAtMs <= nowMs

/**
 * The user's soonest-ending live shift names the pill. A shift past its end is unknown (the read
 * is stale), so a user whose every shift has ended sees nothing until the next read.
 */
export const onCallStatusOf = (snapshot: OnCallSnapshot, nowMs: number): OnCallStatus => {
	if (snapshot.shifts.length === 0) return { _tag: "NoSchedules" }
	const held = Arr.filter(snapshot.shifts, (shift) => shift.userId === snapshot.userId)
	const live = Arr.sort(
		Arr.filter(held, (shift) => !hasEnded(shift, nowMs)),
		byEnd,
	)
	return Option.match(Arr.head(live), {
		onNone: (): OnCallStatus => (held.length > 0 ? { _tag: "Unknown" } : { _tag: "NotOnCall" }),
		onSome: (shift) => ({
			_tag: "OnCall",
			scheduleName: shift.scheduleName,
			otherSchedules: live.length - 1,
			until:
				shift.endsAtMs === null
					? "further notice"
					: formatUntil(shift.endsAtMs, snapshot.viewerTimeZone),
		}),
	})
}

/** The next handoff on any schedule, when who is on call may change. */
export const nextHandoffMs = (snapshot: OnCallSnapshot): number | null => {
	const ends = Arr.flatMap(snapshot.shifts, (shift) => (shift.endsAtMs === null ? [] : [shift.endsAtMs]))
	return ends.length === 0 ? null : Math.min(...ends)
}

// WHEN TO ASK AGAIN

/** The API may lag a handoff by a moment. */
const HANDOFF_SETTLE_MS = 5_000
export const ONCALL_RETRY_MS = 60_000
const ONCALL_RETRY_CAP_MS = 15 * 60_000
/** A shift starting out of a gap shows up in no handoff, so a user off call checks hourly. */
export const ONCALL_IDLE_READ_MS = 60 * 60_000
/** Focus re-reads at most this often. */
export const ONCALL_WAKE_MIN_MS = 60_000
/** An org's "no schedules" answer is trusted this long before asking again. */
export const NO_SCHEDULES_TTL_MS = 24 * 60 * 60_000

export type OnCallSchedule = Readonly<{ nextReadAtMs: number | null; backoffMs: number }>

const backedOff = (nowMs: number, backoffMs: number): OnCallSchedule => {
	const next = backoffMs === 0 ? ONCALL_RETRY_MS : Math.min(backoffMs * 2, ONCALL_RETRY_CAP_MS)
	return { nextReadAtMs: nowMs + next, backoffMs: next }
}

/**
 * After an answer: at the next handoff, or within the hour while the user is off call; a handoff
 * the answer already places in the past (the API has not caught up) retries with backoff.
 */
export const scheduleAfterAnswer = (
	snapshot: OnCallSnapshot,
	nowMs: number,
	backoffMs: number,
): OnCallSchedule => {
	if (snapshot.shifts.length === 0) return { nextReadAtMs: null, backoffMs: 0 }
	const handoff = nextHandoffMs(snapshot)
	if (handoff !== null && handoff <= nowMs) return backedOff(nowMs, backoffMs)
	const isOnCall = onCallStatusOf(snapshot, nowMs)._tag === "OnCall"
	const candidates = [
		...(handoff === null ? [] : [handoff + HANDOFF_SETTLE_MS]),
		...(isOnCall ? [] : [nowMs + ONCALL_IDLE_READ_MS]),
	]
	return { nextReadAtMs: candidates.length === 0 ? null : Math.min(...candidates), backoffMs: 0 }
}

/** After a failed read: retry from a minute, doubling, capped. */
export const scheduleAfterFailure = (nowMs: number, backoffMs: number): OnCallSchedule =>
	backedOff(nowMs, backoffMs)

/** The cached "no schedules" answer for an org is still fresh. */
export const isNoSchedulesFresh = (checkedAtMs: number | undefined, nowMs: number): boolean =>
	checkedAtMs !== undefined && nowMs - checkedAtMs < NO_SCHEDULES_TTL_MS

// COPY

/** The pill's schedule line: "Checkout primary", "Checkout primary +1". */
export const scheduleLabel = (status: Extract<OnCallStatus, { _tag: "OnCall" }>): string =>
	status.otherSchedules === 0 ? status.scheduleName : `${status.scheduleName} +${status.otherSchedules}`

/** The pill's full sentence: the collapsed rail's tooltip and accessible name. */
export const onCallSentence = (status: OnCallStatus): string => {
	switch (status._tag) {
		case "OnCall":
			return `You're on call until ${status.until} (${scheduleLabel(status)})`
		case "NotOnCall":
			return "You're not on call"
		case "NoSchedules":
		case "Unknown":
			return ""
	}
}

/** The pill shows for these. */
export const isPillShown = (status: OnCallStatus): boolean =>
	status._tag === "OnCall" || status._tag === "NotOnCall"
