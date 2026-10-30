import { videoSegmentPayload } from "../../../components/replays/engine/video-engine"
import { Schema } from "effect"

// A replay's derived meta, why it cannot play, and the marker maps. rrweb's enum values are
// inlined: @rrweb/types loads in the Mount.

export const ActionKind = Schema.Literals(["click", "input", "scroll", "nav"])
export type ActionKind = typeof ActionKind.Type

export const ActionMarker = Schema.Struct({ ms: Schema.Number, kind: ActionKind })
export type ActionMarker = typeof ActionMarker.Type

export const InactiveInterval = Schema.Struct({ start: Schema.Number, end: Schema.Number })
export type InactiveInterval = typeof InactiveInterval.Type

export const ReplayMeta = Schema.Struct({
	recordedWidth: Schema.Number,
	recordedHeight: Schema.Number,
	startTime: Schema.Number,
	actionMarkers: Schema.Array(ActionMarker),
	inactiveIntervals: Schema.Array(InactiveInterval),
})
export type ReplayMeta = typeof ReplayMeta.Type

export const MARKER_STYLES = {
	click: "bg-chart-3",
	input: "bg-chart-2",
	scroll: "bg-chart-4",
	nav: "bg-chart-1",
} satisfies Record<ActionKind, string>

/** The same hues as text, and as the soft fill of a selected filter. */
export const MARKER_TEXT = {
	click: "text-chart-3",
	input: "text-chart-2",
	scroll: "text-chart-4",
	nav: "text-chart-1",
} satisfies Record<ActionKind, string>

export const MARKER_SOFT = {
	click: "bg-chart-3/15 text-chart-3",
	input: "bg-chart-2/15 text-chart-2",
	scroll: "bg-chart-4/15 text-chart-4",
	nav: "bg-chart-1/15 text-chart-1",
} satisfies Record<ActionKind, string>

export const MARKER_LABELS = {
	click: "Click",
	input: "Input",
	scroll: "Scroll",
	nav: "Navigate",
} satisfies Record<ActionKind, string>

const EVENT_INCREMENTAL = 3
const EVENT_META = 4
const SOURCE = {
	mouseMove: 1,
	mouseInteraction: 2,
	scroll: 3,
	viewportResize: 4,
	input: 5,
	touchMove: 6,
	drag: 12,
}
const INTERACTION_CLICK = 2
const INTERACTION_TOUCH_START = 7

const IDLE_THRESHOLD_MS = 2000
const MARKER_COALESCE_MS = { click: 150, input: 800, scroll: 400, nav: 0 } satisfies Record<
	ActionKind,
	number
>

const isMovementNoise = (source: number | undefined): boolean =>
	source === SOURCE.mouseMove ||
	source === SOURCE.touchMove ||
	source === SOURCE.drag ||
	source === SOURCE.viewportResize

const RawEvent = Schema.Struct({
	type: Schema.optional(Schema.Number),
	timestamp: Schema.optional(Schema.Number),
	data: Schema.optional(
		Schema.Struct({
			source: Schema.optional(Schema.Number),
			type: Schema.optional(Schema.Number),
			width: Schema.optional(Schema.Number),
			height: Schema.optional(Schema.Number),
			href: Schema.optional(Schema.String),
		}),
	),
})
type RawEvent = typeof RawEvent.Type
const asRawEvent = Schema.decodeUnknownOption(RawEvent)

const eventSpanMs = (event: unknown): number => {
	const duration = videoSegmentPayload(event)?.["duration"]
	return typeof duration === "number" && Number.isFinite(duration) ? Math.max(0, duration) : 0
}

type MetaState = {
	readonly meta: ReplayMeta
	/** Undefined until the first meaningful event when scanning one range of a longer recording. */
	readonly prevMeaningfulTs: number | undefined
	readonly firstMeaningfulTs: number | undefined
	readonly lastMsByKind: Partial<Record<ActionKind, number>>
	readonly lastHref: string | undefined
	readonly firstHref: { readonly href: string; readonly ms: number } | undefined
}

const pushMarker = (state: MetaState, kind: ActionKind, ms: number): MetaState => {
	const last = state.lastMsByKind[kind]
	if (last !== undefined && ms - last < MARKER_COALESCE_MS[kind]) return state
	return {
		...state,
		lastMsByKind: { ...state.lastMsByKind, [kind]: ms },
		meta: { ...state.meta, actionMarkers: [...state.meta.actionMarkers, { ms, kind }] },
	}
}

const step = (state: MetaState, raw: unknown, ev: RawEvent): MetaState => {
	const startTime = state.meta.startTime
	const isIncremental = ev.type === EVENT_INCREMENTAL
	const source = isIncremental ? ev.data?.source : undefined
	const timestamp = ev.timestamp
	const prev = state.prevMeaningfulTs
	const idled =
		timestamp !== undefined && !(isIncremental && isMovementNoise(source))
			? {
					...state,
					prevMeaningfulTs: Math.max(prev ?? timestamp, timestamp + eventSpanMs(raw)),
					firstMeaningfulTs: state.firstMeaningfulTs ?? timestamp,
					meta:
						prev !== undefined && timestamp - prev > IDLE_THRESHOLD_MS
							? {
									...state.meta,
									inactiveIntervals: [
										...state.meta.inactiveIntervals,
										{ start: prev - startTime, end: timestamp - startTime },
									],
								}
							: state.meta,
				}
			: state
	if (ev.type === EVENT_META && ev.data !== undefined) {
		const sized: MetaState = {
			...idled,
			meta: {
				...idled.meta,
				recordedWidth: ev.data.width ?? idled.meta.recordedWidth,
				recordedHeight: ev.data.height ?? idled.meta.recordedHeight,
			},
		}
		const href = ev.data.href
		if (href === undefined || timestamp === undefined) return sized
		const navigated =
			sized.lastHref !== undefined && href !== sized.lastHref
				? pushMarker(sized, "nav", timestamp - startTime)
				: sized
		return {
			...navigated,
			lastHref: href,
			firstHref: navigated.firstHref ?? { href, ms: timestamp - startTime },
		}
	}
	if (!isIncremental || timestamp === undefined) return idled
	const ms = timestamp - startTime
	if (
		source === SOURCE.mouseInteraction &&
		(ev.data?.type === INTERACTION_CLICK || ev.data?.type === INTERACTION_TOUCH_START)
	)
		return pushMarker(idled, "click", ms)
	if (source === SOURCE.input) return pushMarker(idled, "input", ms)
	if (source === SOURCE.scroll) return pushMarker(idled, "scroll", ms)
	return idled
}

const timestampOf = (event: unknown): number | undefined => {
	const decoded = event === undefined ? undefined : asRawEvent(event)
	return decoded !== undefined && decoded._tag === "Some" ? decoded.value.timestamp : undefined
}

const scan = (
	events: ReadonlyArray<unknown>,
	startTime: number,
	prevMeaningfulTs: number | undefined,
): MetaState =>
	events.reduce<MetaState>(
		(state, raw) => {
			const decoded = asRawEvent(raw)
			return decoded._tag === "Some" ? step(state, raw, decoded.value) : state
		},
		{
			meta: {
				recordedWidth: 1280,
				recordedHeight: 720,
				startTime,
				actionMarkers: [],
				inactiveIntervals: [],
			},
			prevMeaningfulTs,
			firstMeaningfulTs: undefined,
			lastMsByKind: {},
			lastHref: undefined,
			firstHref: undefined,
		},
	)

/** Epoch ms of the stream's first event, or 0 for an empty stream. */
export const firstEventMs = (events: ReadonlyArray<unknown>): number => timestampOf(events[0]) ?? 0

/** `deriveMeta`: recorded viewport, action markers and idle gaps from the rrweb stream. */
export const deriveMeta = (events: ReadonlyArray<unknown>): ReplayMeta => {
	const startTime = firstEventMs(events)
	return scan(events, startTime, startTime).meta
}

/** One loaded range's markers and idle gaps, in ms from the recording's origin. */
export const RangeMeta = Schema.Struct({
	fromChunkSeq: Schema.Number,
	toChunkSeq: Schema.Number,
	/** First and last meaningful moments, so the gap to a neighbouring range can be measured. */
	firstMs: Schema.NullOr(Schema.Number),
	lastMs: Schema.NullOr(Schema.Number),
	/** The page the range opens and closes on, so a navigation across the boundary still marks. */
	firstHref: Schema.NullOr(Schema.Struct({ href: Schema.String, ms: Schema.Number })),
	lastHref: Schema.NullOr(Schema.String),
	actionMarkers: Schema.Array(ActionMarker),
	inactiveIntervals: Schema.Array(InactiveInterval),
})
export type RangeMeta = typeof RangeMeta.Type

export const deriveRangeMeta = (
	range: { readonly fromChunkSeq: number; readonly toChunkSeq: number },
	events: ReadonlyArray<unknown>,
	originMs: number,
): RangeMeta => {
	const { meta, prevMeaningfulTs, firstMeaningfulTs, firstHref, lastHref } = scan(
		events,
		originMs,
		undefined,
	)
	return {
		fromChunkSeq: range.fromChunkSeq,
		toChunkSeq: range.toChunkSeq,
		firstMs: firstMeaningfulTs === undefined ? null : firstMeaningfulTs - originMs,
		lastMs: prevMeaningfulTs === undefined ? null : prevMeaningfulTs - originMs,
		firstHref: firstHref ?? null,
		lastHref: lastHref ?? null,
		actionMarkers: meta.actionMarkers,
		inactiveIntervals: meta.inactiveIntervals,
	}
}

/**
 * The whole recording's meta from its loaded ranges. A gap between two ranges counts only when
 * both are loaded and adjacent: an unloaded stretch between them is unknown, not idle.
 */
export const combineRangeMetas = (originMs: number, ranges: ReadonlyArray<RangeMeta>): ReplayMeta => {
	const sorted = ranges.toSorted((a, b) => a.fromChunkSeq - b.fromChunkSeq)
	const adjacent = sorted.flatMap((range, i) => {
		const prev = sorted[i - 1]
		return prev !== undefined && prev.toChunkSeq + 1 === range.fromChunkSeq ? [{ prev, range }] : []
	})
	const gaps = adjacent.flatMap(({ prev, range }) =>
		prev.lastMs !== null && range.firstMs !== null && range.firstMs - prev.lastMs > IDLE_THRESHOLD_MS
			? [{ start: prev.lastMs, end: range.firstMs }]
			: [],
	)
	const navs = adjacent.flatMap(({ prev, range }) =>
		prev.lastHref !== null && range.firstHref !== null && range.firstHref.href !== prev.lastHref
			? [{ ms: range.firstHref.ms, kind: "nav" as const }]
			: [],
	)
	return {
		recordedWidth: 1280,
		recordedHeight: 720,
		startTime: originMs,
		actionMarkers: [...sorted.flatMap((range) => range.actionMarkers), ...navs].toSorted(
			(a, b) => a.ms - b.ms,
		),
		inactiveIntervals: [...sorted.flatMap((range) => range.inactiveIntervals), ...gaps].toSorted(
			(a, b) => a.start - b.start,
		),
	}
}

/** `classifyUnplayable`: a recording still arriving (`empty`) or never made (`unrecorded`). */
export const classifyUnplayable = (input: {
	readonly recorded: boolean | undefined
	readonly chunkCount: number
	readonly sessionActive: boolean
}): "empty" | "unrecorded" => {
	if (input.recorded === false) return "unrecorded"
	if (input.recorded === undefined && input.chunkCount === 0 && !input.sessionActive) return "unrecorded"
	return "empty"
}
