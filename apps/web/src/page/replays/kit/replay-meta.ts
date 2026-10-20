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

export const MARKER_LABELS = {
	click: "Click",
	input: "Input",
	scroll: "Scroll",
	nav: "Navigate",
} satisfies Record<ActionKind, string>

const EVENT_INCREMENTAL = 3
const EVENT_META = 4
const SOURCE = { mouseMove: 1, mouseInteraction: 2, scroll: 3, viewportResize: 4, input: 5, touchMove: 6, drag: 12 }
const INTERACTION_CLICK = 2
const INTERACTION_TOUCH_START = 7

const IDLE_THRESHOLD_MS = 2000
const MARKER_COALESCE_MS = { click: 150, input: 800, scroll: 400, nav: 0 } satisfies Record<ActionKind, number>

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
	readonly prevMeaningfulTs: number
	readonly lastMsByKind: Partial<Record<ActionKind, number>>
	readonly lastHref: string | undefined
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
	const idled =
		timestamp !== undefined && !(isIncremental && isMovementNoise(source))
			? {
					...state,
					prevMeaningfulTs: Math.max(state.prevMeaningfulTs, timestamp + eventSpanMs(raw)),
					meta:
						timestamp - state.prevMeaningfulTs > IDLE_THRESHOLD_MS
							? {
									...state.meta,
									inactiveIntervals: [
										...state.meta.inactiveIntervals,
										{ start: state.prevMeaningfulTs - startTime, end: timestamp - startTime },
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
			sized.lastHref !== undefined && href !== sized.lastHref ? pushMarker(sized, "nav", timestamp - startTime) : sized
		return { ...navigated, lastHref: href }
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

/** `deriveMeta`: recorded viewport, action markers and idle gaps from the rrweb stream. */
export const deriveMeta = (events: ReadonlyArray<unknown>): ReplayMeta => {
	const first = events[0] === undefined ? undefined : asRawEvent(events[0])
	const startTime = first !== undefined && first._tag === "Some" ? (first.value.timestamp ?? 0) : 0
	const initial: MetaState = {
		meta: { recordedWidth: 1280, recordedHeight: 720, startTime, actionMarkers: [], inactiveIntervals: [] },
		prevMeaningfulTs: startTime,
		lastMsByKind: {},
		lastHref: undefined,
	}
	return events.reduce<MetaState>((state, raw) => {
		const decoded = asRawEvent(raw)
		return decoded._tag === "Some" ? step(state, raw, decoded.value) : state
	}, initial).meta
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
