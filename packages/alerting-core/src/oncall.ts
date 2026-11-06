import { Array as Arr, DateTime, Option, Order, String as Str } from "effect"
import { ONCALL_LOOKAROUND_MS } from "@maple/domain/http"
import type {
	OnCallLayer,
	OnCallOverride,
	OnCallRestriction,
	OnCallRotation,
	OnCallScheduleConfig,
	OnCallWeekday,
} from "@maple/domain/http"
import type { OnCallOverrideId, UserId } from "@maple/domain/primitives"

// Pure on-call resolution. Handoffs and restrictions are local wall-clock times in the
// schedule's zone. A local time inside a DST gap moves forward by the gap (02:30 becomes
// 03:30); a repeated local time resolves to its first occurrence (Temporal "compatible").

/** Render ranges are clamped to this length past `fromMs`. */
export const MAX_ONCALL_RENDER_RANGE_MS = 90 * 86_400_000
/** Each layer yields at most this many rotation shifts per render; later ones are dropped. */
export const MAX_ONCALL_SHIFTS_PER_LAYER = 5_000
/** `onCallAt` resolves within this distance of the instant, so its bounds are clamped to it. */
export { ONCALL_LOOKAROUND_MS }

export type OnCallSource =
	| { readonly kind: "override"; readonly overrideId: OnCallOverrideId }
	| { readonly kind: "layer"; readonly layerIndex: number }

export interface OnCallShift {
	readonly userId: UserId
	readonly startMs: number
	readonly endMs: number
	readonly source: OnCallSource
}

export interface OnCallRender {
	/** Each layer's own shifts after its restrictions, clipped to the range. */
	readonly layers: ReadonlyArray<ReadonlyArray<OnCallShift>>
	/** The effective schedule after layering and overrides. */
	readonly final: ReadonlyArray<OnCallShift>
}

interface Interval {
	readonly startMs: number
	readonly endMs: number
}

const DAY_MS = 86_400_000
const HOUR_MS = 3_600_000

const WEEKDAYS: ReadonlyArray<OnCallWeekday> = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"]
const weekdayIndex = (weekday: OnCallWeekday): number =>
	Arr.findFirstIndex(WEEKDAYS, (d) => d === weekday).pipe(Option.getOrElse(() => 0))

const mod = (n: number, m: number): number => ((n % m) + m) % m

// Civil days are counted from 1970-01-01 (a Thursday), independent of any zone.
const weekdayOfDay = (day: number): number => mod(day + 3, 7)

const parseLocalTime = (time: string) => ({
	hour: Number(Str.slice(0, 2)(time)),
	minute: Number(Str.slice(3, 5)(time)),
})

const localDayOf = (zone: DateTime.TimeZone, ms: number): number => {
	const parts = DateTime.toParts(DateTime.makeZonedUnsafe(ms, { timeZone: zone }))
	return Math.floor(Date.UTC(parts.year, parts.month - 1, parts.day) / DAY_MS)
}

/** The instant of a local wall-clock time on a civil day. */
const localTimeOnDay = (zone: DateTime.TimeZone, day: number, time: string): number => {
	const civil = DateTime.toPartsUtc(DateTime.makeUnsafe(day * DAY_MS))
	const { hour, minute } = parseLocalTime(time)
	return DateTime.makeZoned(
		{ year: civil.year, month: civil.month, day: civil.day, hour, minute },
		{ timeZone: zone, adjustForTimeZone: true, disambiguation: "compatible" },
	).pipe(
		Option.map(DateTime.toEpochMillis),
		Option.getOrElse(() => day * DAY_MS + hour * HOUR_MS + minute * 60_000),
	)
}

interface RotationClock {
	/** Index of the rotation shift containing `ms` (0 is the shift containing the anchor). */
	readonly indexAt: (ms: number) => number
	readonly bounds: (index: number) => Interval
}

const rotationClock = (
	zone: DateTime.TimeZone,
	rotation: OnCallRotation,
	anchorMs: number,
): RotationClock => {
	if (rotation.kind === "custom") {
		const lengthMs = rotation.lengthHours * HOUR_MS
		return {
			indexAt: (ms) => Math.floor((ms - anchorMs) / lengthMs),
			bounds: (index) => ({
				startMs: anchorMs + index * lengthMs,
				endMs: anchorMs + (index + 1) * lengthMs,
			}),
		}
	}
	const step = rotation.kind === "daily" ? 1 : 7
	const weekdayOffset = (day: number) =>
		rotation.kind === "daily" ? 0 : mod(weekdayOfDay(day) - weekdayIndex(rotation.handoffWeekday), 7)
	// The handoff day of the shift containing `ms`.
	const handoffDayAt = (ms: number): number => {
		const day = localDayOf(zone, ms)
		const candidate = day - weekdayOffset(day)
		return localTimeOnDay(zone, candidate, rotation.handoffTime) <= ms ? candidate : candidate - step
	}
	const anchorDay = handoffDayAt(anchorMs)
	return {
		indexAt: (ms) => Math.round((handoffDayAt(ms) - anchorDay) / step),
		bounds: (index) => ({
			startMs: localTimeOnDay(zone, anchorDay + index * step, rotation.handoffTime),
			endMs: localTimeOnDay(zone, anchorDay + (index + 1) * step, rotation.handoffTime),
		}),
	}
}

const byStart = Order.mapInput(Order.Number, (interval: Interval) => interval.startMs)

const mergeIntervals = (intervals: ReadonlyArray<Interval>): Array<Interval> =>
	Arr.reduce(Arr.sort(intervals, byStart), Arr.empty<Interval>(), (acc, next) => {
		const last = acc[acc.length - 1]
		// Accumulators are local to the fold, so in-place updates keep it linear.
		if (last !== undefined && next.startMs <= last.endMs) {
			acc[acc.length - 1] = { startMs: last.startMs, endMs: Math.max(last.endMs, next.endMs) }
		} else {
			acc.push(next)
		}
		return acc
	})

/** Active windows of a layer's restrictions overlapping [fromMs, toMs). */
const restrictionWindows = (
	zone: DateTime.TimeZone,
	restrictions: ReadonlyArray<OnCallRestriction>,
	fromMs: number,
	toMs: number,
): Array<Interval> => {
	// Start a day early so a window crossing midnight into the range is included.
	const days = Arr.range(localDayOf(zone, fromMs) - 1, localDayOf(zone, toMs))
	const raw = Arr.flatMap(days, (day) =>
		Arr.flatMap(restrictions, (restriction) => {
			const weekday = WEEKDAYS[weekdayOfDay(day)]
			if (!Arr.some(restriction.weekdays, (d) => d === weekday)) return []
			const crossesMidnight = restriction.endTime <= restriction.startTime
			const window = {
				startMs: localTimeOnDay(zone, day, restriction.startTime),
				endMs: localTimeOnDay(zone, crossesMidnight ? day + 1 : day, restriction.endTime),
			}
			return window.endMs > window.startMs ? [window] : []
		}),
	)
	return Arr.filter(mergeIntervals(raw), (w) => w.endMs > fromMs && w.startMs < toMs)
}

const clip = (interval: Interval, fromMs: number, toMs: number): Option.Option<Interval> => {
	const startMs = Math.max(interval.startMs, fromMs)
	const endMs = Math.min(interval.endMs, toMs)
	return endMs > startMs ? Option.some({ startMs, endMs }) : Option.none()
}

const layerShifts = (
	zone: DateTime.TimeZone,
	layer: OnCallLayer,
	layerIndex: number,
	fromMs: number,
	toMs: number,
): Array<OnCallShift> => {
	const startMs = Math.max(fromMs, layer.startsAt)
	if (startMs >= toMs) return []
	const clock = rotationClock(zone, layer.rotation, layer.startsAt)
	const first = clock.indexAt(startMs)
	const count = Math.min(clock.indexAt(toMs - 1) - first + 1, MAX_ONCALL_SHIFTS_PER_LAYER)
	const source: OnCallSource = { kind: "layer", layerIndex }
	const rotationShifts = Arr.flatMap(
		Arr.makeBy(Math.max(count, 1), (i) => first + i),
		(index) =>
			clip(clock.bounds(index), startMs, toMs).pipe(
				Option.map((interval) => ({
					...interval,
					userId:
						layer.participants[mod(index, layer.participants.length)] ?? layer.participants[0],
					source,
				})),
				Option.toArray,
			),
	)
	const restrictions = layer.restrictions ?? []
	if (!Arr.isReadonlyArrayNonEmpty(restrictions)) return rotationShifts
	const windows = restrictionWindows(zone, restrictions, startMs, toMs)
	return Arr.flatMap(rotationShifts, (shift) =>
		Arr.flatMap(windows, (window) =>
			clip(window, shift.startMs, shift.endMs).pipe(
				Option.map((piece) => ({ ...shift, ...piece })),
				Option.toArray,
			),
		),
	)
}

/** Binary search over sorted, disjoint shifts. */
const shiftCovering = (
	shifts: ReadonlyArray<OnCallShift>,
	ms: number,
	lo = 0,
	hi = shifts.length - 1,
): Option.Option<OnCallShift> => {
	if (lo > hi) return Option.none()
	const mid = Math.floor((lo + hi) / 2)
	const shift = shifts[mid]
	if (shift === undefined) return Option.none()
	if (ms < shift.startMs) return shiftCovering(shifts, ms, lo, mid - 1)
	if (ms >= shift.endMs) return shiftCovering(shifts, ms, mid + 1, hi)
	return Option.some(shift)
}

// Most recently created wins; the id breaks ties so the choice is deterministic.
const overrideOrder = Order.combine(
	Order.mapInput(Order.Number, (o: OnCallOverride) => o.createdAt),
	Order.mapInput(Order.String, (o: OnCallOverride) => o.id),
)

const sameSource = (a: OnCallSource, b: OnCallSource): boolean =>
	a.kind === "override"
		? b.kind === "override" && a.overrideId === b.overrideId
		: b.kind === "layer" && a.layerIndex === b.layerIndex

const resolveZone = (config: OnCallScheduleConfig): DateTime.TimeZone =>
	// A decoded config always names a valid zone; UTC only guards undecoded input.
	Option.getOrElse(DateTime.zoneMakeNamed(config.timeZone), () => DateTime.zoneMakeOffset(0))

/**
 * Render each layer and the effective schedule over [fromMs, toMs). The range is clamped
 * to MAX_ONCALL_RENDER_RANGE_MS and each layer to MAX_ONCALL_SHIFTS_PER_LAYER shifts.
 */
export const renderOnCall = (
	config: OnCallScheduleConfig,
	overrides: ReadonlyArray<OnCallOverride>,
	fromMs: number,
	toMs: number,
): OnCallRender => {
	const endMs = Math.min(toMs, fromMs + MAX_ONCALL_RENDER_RANGE_MS)
	if (endMs <= fromMs) return { layers: Arr.map(config.layers, () => []), final: [] }
	const zone = resolveZone(config)
	const layers = Arr.map(config.layers, (layer, index) => layerShifts(zone, layer, index, fromMs, endMs))
	const activeOverrides = Arr.filter(
		overrides,
		(o) => o.endsAt > o.startsAt && o.endsAt > fromMs && o.startsAt < endMs,
	)

	// Every boundary in play, so the winner is constant on each elementary segment.
	const boundaries = Arr.dedupeAdjacent(
		Arr.sort(
			Arr.flatten([
				[fromMs, endMs],
				Arr.flatMap(Arr.flatten(layers), (s) => [s.startMs, s.endMs]),
				Arr.flatMap(activeOverrides, (o) => [
					Math.max(o.startsAt, fromMs),
					Math.min(o.endsAt, endMs),
				]),
			]),
			Order.Number,
		),
	)
	const segments = Arr.zipWith(
		Arr.dropRight(boundaries, 1),
		Arr.drop(boundaries, 1),
		(startMs, segEnd) => ({
			startMs,
			endMs: segEnd,
		}),
	)

	const winnerAt = (ms: number): Option.Option<Pick<OnCallShift, "userId" | "source">> => {
		const covering = Arr.filter(activeOverrides, (o) => o.startsAt <= ms && ms < o.endsAt)
		if (Arr.isArrayNonEmpty(covering)) {
			const winner = Arr.max(covering, overrideOrder)
			return Option.some({ userId: winner.userId, source: { kind: "override", overrideId: winner.id } })
		}
		return Arr.findFirst(Arr.reverse(layers), (shifts) => shiftCovering(shifts, ms))
	}

	const final = Arr.reduce(segments, Arr.empty<OnCallShift>(), (acc, segment) =>
		Option.match(winnerAt(segment.startMs), {
			onNone: () => acc,
			onSome: (winner) => {
				const last = acc[acc.length - 1]
				if (
					last !== undefined &&
					last.endMs === segment.startMs &&
					last.userId === winner.userId &&
					sameSource(last.source, winner.source)
				) {
					acc[acc.length - 1] = { ...last, endMs: segment.endMs }
				} else {
					acc.push({ ...winner, ...segment })
				}
				return acc
			},
		}),
	)
	return { layers, final }
}

/**
 * Who is on call at `atMs`, with the bounds of the effective shift containing it (clamped
 * to ONCALL_LOOKAROUND_MS either side). Null is a gap: nobody is on call.
 */
export const onCallAt = (
	config: OnCallScheduleConfig,
	overrides: ReadonlyArray<OnCallOverride>,
	atMs: number,
): OnCallShift | null =>
	Option.getOrNull(
		shiftCovering(
			renderOnCall(config, overrides, atMs - ONCALL_LOOKAROUND_MS, atMs + ONCALL_LOOKAROUND_MS).final,
			atMs,
		),
	)
