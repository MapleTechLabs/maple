import { onCallAt, renderOnCall, type OnCallShift } from "@maple/alerting-core/oncall"
import { OnCallLayer, OnCallScheduleConfig, OnCallTimeZone } from "@maple/domain/http"
import type { OnCallOverride } from "@maple/domain/http"
import type { UserId } from "@maple/primitives"
import { zonedDateParts } from "@maple/query-engine/datetime"
import { zonedDayStart } from "@maple/views/ui/shift-timeline"
import { Array as Arr, Option, Order, Result, Schema, String as Str } from "effect"
import { layerStartMs, restrictionError, type Form, type LayerDraft } from "../schedule-form/form"

// Coverage preview: the draft rendered with the server's own `renderOnCall`, so the preview
// and paging agree, plus the gaps where nobody is on call.

export interface Interval {
	readonly startMs: number
	readonly endMs: number
}

const byStart = Order.mapInput(Order.Number, (interval: Interval) => interval.startMs)

/** The stretches of [fromMs, toMs) that no shift covers. */
export const gapsOf = (
	shifts: ReadonlyArray<Interval>,
	fromMs: number,
	toMs: number,
): ReadonlyArray<Interval> => {
	if (toMs <= fromMs) return []
	const sorted = Arr.sort(shifts, byStart)
	const { gaps, cursor } = Arr.reduce(
		sorted,
		{ gaps: Arr.empty<Interval>(), cursor: fromMs },
		({ gaps, cursor }, shift) => {
			if (shift.endMs <= cursor || shift.startMs >= toMs) return { gaps, cursor }
			const next = shift.startMs > cursor ? [...gaps, { startMs: cursor, endMs: shift.startMs }] : gaps
			return { gaps: next, cursor: Math.max(cursor, shift.endMs) }
		},
	)
	return cursor < toMs ? [...gaps, { startMs: cursor, endMs: toMs }] : gaps
}

const isZone = Schema.is(OnCallTimeZone)
const decodeLayer = Schema.decodeUnknownOption(OnCallLayer)
const decodeConfig = Schema.decodeUnknownOption(OnCallScheduleConfig)

/**
 * A draft layer as the engine's layer, once it has people, a valid rotation and valid windows.
 * A half-typed window is none, not "always active": the engine reads no windows as 24/7.
 */
export const previewLayerOf = (layer: LayerDraft, timeZone: string): Option.Option<OnCallLayer> =>
	Arr.some(layer.restrictions, (restriction) => Option.isSome(restrictionError(restriction)))
		? Option.none()
		: Option.flatMap(layerStartMs(layer, timeZone), (startsAt) =>
				decodeLayer(engineLayerOf(layer, startsAt)),
			)

const engineLayerOf = (layer: LayerDraft, startsAt: number) => ({
	// The name never changes who is on call, so a blank one still previews.
	name: Str.isEmpty(Str.trim(layer.name)) ? "Layer" : Str.slice(0, 100)(Str.trim(layer.name)),
	participants: layer.participants,
	rotation:
		layer.rotation === "custom"
			? { kind: "custom", lengthHours: Number(Str.trim(layer.lengthHours)) }
			: layer.rotation === "daily"
				? { kind: "daily", handoffTime: layer.handoffTime }
				: {
						kind: "weekly",
						handoffWeekday: layer.handoffWeekday,
						handoffTime: layer.handoffTime,
					},
	startsAt,
	restrictions: Arr.map(layer.restrictions, ({ weekdays, startTime, endTime }) => ({
		weekdays,
		startTime,
		endTime,
	})),
})

/** Who the layer alone has on call at `atMs`; none in one of its gaps, or while it cannot preview. */
export const layerOnCallAt = (layer: LayerDraft, timeZone: string, atMs: number): Option.Option<UserId> =>
	previewLayerOf(layer, timeZone).pipe(
		Option.flatMap((engineLayer) => decodeConfig({ timeZone, layers: [engineLayer] })),
		Option.flatMap((config) => Option.fromNullishOr(onCallAt(config, [], atMs))),
		Option.map((shift) => shift.userId),
	)

export interface DraftConfig {
	readonly config: OnCallScheduleConfig
	/** The draft layer each config layer came from. */
	readonly draftIndexes: ReadonlyArray<number>
}

/** The draft as an engine config, keeping only the layers that can preview; none while no layer can. */
export const draftConfigOf = (form: Pick<Form, "timeZone" | "layers">): Option.Option<DraftConfig> => {
	if (!isZone(form.timeZone)) return Option.none()
	const usable = Arr.filterMap(form.layers, (layer, index) =>
		Option.match(previewLayerOf(layer, form.timeZone), {
			onNone: () => Result.failVoid,
			onSome: (engineLayer) => Result.succeed({ engineLayer, index }),
		}),
	)
	return Option.map(
		decodeConfig({ timeZone: form.timeZone, layers: Arr.map(usable, (u) => u.engineLayer) }),
		(config) => ({ config, draftIndexes: Arr.map(usable, (u) => u.index) }),
	)
}

export interface Coverage {
	/** Per draft layer: its shifts, or none while it cannot preview (no people, bad times). */
	readonly layers: ReadonlyArray<Option.Option<ReadonlyArray<OnCallShift>>>
	readonly final: ReadonlyArray<OnCallShift>
	/** Gaps in the final schedule from `max(fromMs, nowMs)`: the past is not scheduled. */
	readonly gaps: ReadonlyArray<Interval>
}

/** The draft's layers, final schedule and gaps over [fromMs, toMs). */
export const draftCoverage = (
	form: Pick<Form, "timeZone" | "layers">,
	overrides: ReadonlyArray<OnCallOverride>,
	fromMs: number,
	toMs: number,
	nowMs: number,
): Coverage => {
	const gapFrom = Math.max(fromMs, nowMs)
	return Option.match(draftConfigOf(form), {
		onNone: () => ({
			layers: Arr.map(form.layers, () => Option.none()),
			final: [],
			gaps: gapsOf([], gapFrom, toMs),
		}),
		onSome: ({ config, draftIndexes }) => {
			const render = renderOnCall(config, overrides, fromMs, toMs)
			return {
				layers: Arr.map(form.layers, (_, draftIndex) =>
					Option.flatMap(
						Arr.findFirstIndex(draftIndexes, (i) => i === draftIndex),
						(configIndex) => Option.fromNullishOr(render.layers[configIndex]),
					),
				),
				final: render.final,
				gaps: gapsOf(render.final, gapFrom, toMs),
			}
		},
	})
}

// RANGE: whole wall-clock days in the schedule's zone, so DST days are 23 or 25 hours.

/** `days` wall-clock days from the start of today, `weekOffset` weeks on. */
export const previewRange = (
	nowMs: number,
	timeZone: string,
	weekOffset: number,
	days: number,
): Interval => ({
	startMs: zonedDayStart(nowMs, timeZone, weekOffset * 7),
	endMs: zonedDayStart(nowMs, timeZone, weekOffset * 7 + days),
})

// COPY

const formatters = new Map<string, Intl.DateTimeFormat>()
const formatterOf = (timeZone: string, kind: "day" | "time"): Intl.DateTimeFormat => {
	const key = `${timeZone}|${kind}`
	const cached = formatters.get(key)
	if (cached !== undefined) return cached
	const formatter = new Intl.DateTimeFormat(
		"en-GB",
		kind === "day"
			? {
					timeZone,
					weekday: "short",
					day: "numeric",
					month: "short",
					hour: "2-digit",
					minute: "2-digit",
					hourCycle: "h23",
				}
			: { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" },
	)
	formatters.set(key, formatter)
	return formatter
}

const sameDay = (a: number, b: number, timeZone: string) => {
	const pa = zonedDateParts(a, timeZone)
	const pb = zonedDateParts(b, timeZone)
	return pa.year === pb.year && pa.month === pb.month && pa.day === pb.day
}

const dropComma = Str.replace(",", "")

/** A gap that runs to the end of what was checked: its real end is not known. */
export const isOpenGap = (gap: Interval, checkedToMs: number): boolean => gap.endMs >= checkedToMs

/** "Sat 21 Nov 00:00 to 16:00", both ends in full across days, or "from Sat 21 Nov 00:00" when open. */
export const gapRangeText = (gap: Interval, timeZone: string, checkedToMs: number): string => {
	const start = dropComma(formatterOf(timeZone, "day").format(gap.startMs))
	if (isOpenGap(gap, checkedToMs)) return `from ${start}`
	const end = sameDay(gap.startMs, gap.endMs, timeZone)
		? formatterOf(timeZone, "time").format(gap.endMs)
		: dropComma(formatterOf(timeZone, "day").format(gap.endMs))
	return `${start} to ${end}`
}

/** "16h", "1h 30m", "3d 4h": a gap's length. Minutes show only under a day; a longer one reads in days and hours. */
export const durationText = (ms: number): string => {
	const minutes = Math.round(ms / 60_000)
	const days = Math.floor(minutes / 1440)
	const hours = Math.floor((minutes % 1440) / 60)
	const mins = minutes % 60
	const parts = [
		...(days > 0 ? [`${days}d`] : []),
		...(hours > 0 ? [`${hours}h`] : []),
		...(mins > 0 && days === 0 ? [`${mins}m`] : []),
	]
	return parts.length === 0 ? "0m" : Arr.join(parts, " ")
}

/** The longest gap; the earliest among equals. */
export const longestGap = (gaps: ReadonlyArray<Interval>): Option.Option<Interval> =>
	Arr.reduce(gaps, Option.none<Interval>(), (best, gap) =>
		Option.match(best, {
			onNone: () => Option.some(gap),
			onSome: (b) => (gap.endMs - gap.startMs > b.endMs - b.startMs ? Option.some(gap) : best),
		}),
	)

/** What the summary is about: the zone and the stretch checked for gaps. */
export type GapScope = Readonly<{
	timeZone: string
	/** Gaps are checked over [checkedFromMs, checkedToMs): from now to the range's end. */
	checkedFromMs: number
	checkedToMs: number
}>

/** One gap spanning everything checked: nobody is on call at all. */
export const isUncovered = (
	gaps: ReadonlyArray<Interval>,
	scope: Pick<GapScope, "checkedFromMs" | "checkedToMs">,
): boolean => {
	const only = gaps.length === 1 ? gaps[0] : undefined
	return only !== undefined && only.startMs <= scope.checkedFromMs && only.endMs >= scope.checkedToMs
}

/**
 * "2 gaps in this period, longest 16h (Sat 21 Nov 00:00 to 16:00)", "Covered in this period", or
 * "Nobody is on call in this period" when the one gap is everything checked. "This period" is the
 * range drawn: it ends at its last midnight, so a range from today is never a full "next N days".
 */
export const gapSummary = (gaps: ReadonlyArray<Interval>, scope: GapScope): string => {
	if (isUncovered(gaps, scope)) return "Nobody is on call in this period"
	return Option.match(longestGap(gaps), {
		onNone: () => "Covered in this period",
		onSome: (longest) =>
			`${gaps.length} ${gaps.length === 1 ? "gap" : "gaps"} in this period, longest ${durationText(longest.endMs - longest.startMs)}${isOpenGap(longest, scope.checkedToMs) ? " or longer" : ""} (${gapRangeText(longest, scope.timeZone, scope.checkedToMs)})`,
	})
}
