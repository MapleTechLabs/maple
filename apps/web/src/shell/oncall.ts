import { Array as Arr, Option, Order, Schema } from "effect"
import { formatShiftEdge } from "../page/alerts/shared/oncall-schedules"

// The sidebar's on-call pill: each schedule's current shift, as the schedules list reads it now.

/** One schedule's current shift: who holds it until when, `null` in a gap. */
export const OnCallShift = Schema.Struct({
	scheduleName: Schema.String,
	timeZone: Schema.String,
	userId: Schema.NullOr(Schema.String),
	endsAtMs: Schema.NullOr(Schema.Number),
})
export type OnCallShift = typeof OnCallShift.Type

/** The signed-in user and every schedule of the org. */
export const OnCallSnapshot = Schema.Struct({
	userId: Schema.String,
	shifts: Schema.Array(OnCallShift),
})
export type OnCallSnapshot = typeof OnCallSnapshot.Type

export type OnCallStatus =
	| Readonly<{ _tag: "NoSchedules" }>
	| Readonly<{ _tag: "NotOnCall" }>
	| Readonly<{
			_tag: "OnCall"
			scheduleName: string
			/** Other schedules the user also holds now. */
			otherSchedules: number
			until: string
	  }>

const byEnd = Order.mapInput(Order.Number, (shift: OnCallShift) => shift.endsAtMs ?? Number.POSITIVE_INFINITY)

/** The user's soonest-ending shift names the pill; an org without schedules shows none. */
export const onCallStatusOf = (snapshot: OnCallSnapshot): OnCallStatus => {
	if (snapshot.shifts.length === 0) return { _tag: "NoSchedules" }
	const mine = Arr.sort(
		Arr.filter(snapshot.shifts, (shift) => shift.userId === snapshot.userId),
		byEnd,
	)
	return Option.match(Arr.head(mine), {
		onNone: () => ({ _tag: "NotOnCall" }),
		onSome: (shift) => ({
			_tag: "OnCall",
			scheduleName: shift.scheduleName,
			otherSchedules: mine.length - 1,
			until:
				shift.endsAtMs === null ? "further notice" : formatShiftEdge(shift.endsAtMs, shift.timeZone),
		}),
	})
}

/** The next handoff on any schedule, when who is on call may change. */
export const nextHandoffMs = (snapshot: OnCallSnapshot): number | null => {
	const ends = Arr.flatMap(snapshot.shifts, (shift) => (shift.endsAtMs === null ? [] : [shift.endsAtMs]))
	return ends.length === 0 ? null : Math.min(...ends)
}

/** The pill's schedule line: "Checkout primary", "Checkout primary +1". */
export const scheduleLabel = (status: Extract<OnCallStatus, { _tag: "OnCall" }>): string =>
	status.otherSchedules === 0 ? status.scheduleName : `${status.scheduleName} +${status.otherSchedules}`

/** The pill's full sentence: its title, and the collapsed rail's tooltip. */
export const onCallSentence = (status: OnCallStatus): string => {
	switch (status._tag) {
		case "OnCall":
			return `You're on call until ${status.until} (${scheduleLabel(status)})`
		case "NotOnCall":
			return "You're not on call"
		case "NoSchedules":
			return ""
	}
}
