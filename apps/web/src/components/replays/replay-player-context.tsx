import * as React from "react"
import { Replayer } from "@rrweb/replay"
import { EventType, IncrementalSource, MouseInteractions, ReplayerEvents } from "@rrweb/types"
import { Result, useAtomValue } from "@/lib/effect-atom"
import {
	getReplayEventsResultAtom,
	replayChunkEventsAtom,
	replayChunkEventsKey,
} from "@/lib/services/atoms/tinybird-query-atoms"
import { buildTimeline, type InactiveInterval, type Timeline } from "./replay-timeline"

// ---------------------------------------------------------------------------
// Replay player context
//
// The rrweb engine + transport state used to live inside the player surface.
// The video-editor layout renders the surface and the timeline strip in
// separate parts of the page, so both need to read `currentMs` and drive
// `seek`. This provider owns the engine and exposes that state via context;
// `<ReplaySurface>` and `<ReplayEditorTimeline>` are both consumers.
// ---------------------------------------------------------------------------

interface ReplayChunkUrl {
	readonly chunkSeq: number
	readonly url: string
}

/** A user interaction worth flagging on the scrubber. */
export type ActionKind = "click" | "input" | "scroll" | "nav"

/** An action marker positioned on the displayed (trimmed) timeline. */
export interface DisplayMarker {
	ms: number
	kind: ActionKind
}

/** An idle band positioned on the displayed (trimmed) timeline. */
export interface IdleBand {
	start: number
	end: number
}

/** `ms` is the real offset from session start (matching `getCurrentTime()`). */
interface ActionMarker {
	ms: number
	kind: ActionKind
}

/** Recorded viewport + action markers + idle gaps from the raw rrweb stream. */
interface DerivedMeta {
	recordedWidth: number
	recordedHeight: number
	/** First rrweb event timestamp (ms-epoch) — the playhead's time-zero. */
	startTime: number
	actionMarkers: ActionMarker[]
	inactiveIntervals: InactiveInterval[]
}

/** Gaps longer than this between meaningful events count as idle. */
const IDLE_THRESHOLD_MS = 2000

/**
 * Per-kind coalescing window: a marker is dropped if one of the same kind landed
 * within this many ms before it. Keystrokes (`input`) and scroll bursts collapse
 * into a single waypoint; clicks only dedupe double-clicks. `nav` is deduped by
 * URL instead, so its window is unused.
 */
const MARKER_COALESCE_MS: Record<ActionKind, number> = {
	click: 150,
	input: 800,
	scroll: 400,
	nav: 0,
}

/**
 * Pointer drift and viewport jitter aren't "activity" for idle purposes — a user
 * reading a page while nudging the mouse is idle. Excluding these sources is what
 * makes a real idle stretch register as a gap (raw event cadence never goes quiet).
 */
function isMovementNoise(source: number | undefined): boolean {
	return (
		source === IncrementalSource.MouseMove ||
		source === IncrementalSource.TouchMove ||
		source === IncrementalSource.Drag ||
		source === IncrementalSource.ViewportResize
	)
}

function deriveMeta(events: unknown[]): DerivedMeta {
	let recordedWidth = 1280
	let recordedHeight = 720
	const actionMarkers: ActionMarker[] = []
	const inactiveIntervals: InactiveInterval[] = []
	const startTime = (events[0] as { timestamp?: number } | undefined)?.timestamp ?? 0
	// Last *meaningful* (non-movement) event time — idle is measured against this.
	let prevMeaningfulTs = startTime
	const lastMsByKind: Partial<Record<ActionKind, number>> = {}
	let lastHref: string | undefined

	// Add a marker unless one of the same kind landed within its coalesce window.
	const pushMarker = (kind: ActionKind, ms: number) => {
		const last = lastMsByKind[kind]
		if (last !== undefined && ms - last < MARKER_COALESCE_MS[kind]) return
		lastMsByKind[kind] = ms
		actionMarkers.push({ ms, kind })
	}

	for (const raw of events) {
		const ev = raw as {
			type?: number
			timestamp?: number
			data?: {
				source?: number
				type?: number
				width?: number
				height?: number
				href?: string
			}
		}
		const isIncremental = ev.type === EventType.IncrementalSnapshot
		const source = isIncremental ? ev.data?.source : undefined

		if (typeof ev.timestamp === "number" && !(isIncremental && isMovementNoise(source))) {
			if (ev.timestamp - prevMeaningfulTs > IDLE_THRESHOLD_MS) {
				inactiveIntervals.push({
					start: prevMeaningfulTs - startTime,
					end: ev.timestamp - startTime,
				})
			}
			prevMeaningfulTs = ev.timestamp
		}

		if (ev.type === EventType.Meta && ev.data) {
			if (typeof ev.data.width === "number") recordedWidth = ev.data.width
			if (typeof ev.data.height === "number") recordedHeight = ev.data.height
			// Periodic checkouts re-emit Meta with the same href — only a genuine URL
			// change is a navigation worth marking.
			if (typeof ev.data.href === "string" && typeof ev.timestamp === "number") {
				if (lastHref !== undefined && ev.data.href !== lastHref) {
					pushMarker("nav", ev.timestamp - startTime)
				}
				lastHref = ev.data.href
			}
		} else if (isIncremental && typeof ev.timestamp === "number") {
			const ms = ev.timestamp - startTime
			if (
				source === IncrementalSource.MouseInteraction &&
				ev.data?.type === MouseInteractions.Click
			) {
				pushMarker("click", ms)
			} else if (source === IncrementalSource.Input) {
				pushMarker("input", ms)
			} else if (source === IncrementalSource.Scroll) {
				pushMarker("scroll", ms)
			}
		}
	}
	return { recordedWidth, recordedHeight, startTime, actionMarkers, inactiveIntervals }
}

export type ReplayLoadStatus = "loading" | "error" | "empty" | "ready"

export interface ReplayPlayerContextValue {
	status: ReplayLoadStatus
	error: unknown
	/** Fullscreen target (the surface figure). */
	figureRef: React.RefObject<HTMLElement | null>
	surfaceRef: React.RefObject<HTMLDivElement | null>
	mountRef: React.RefObject<HTMLDivElement | null>
	recordedWidth: number
	recordedHeight: number
	isPlaying: boolean
	finished: boolean
	/** Current playhead position, in trimmed (display) ms. */
	displayCurrentMs: number
	/** Total length, in trimmed (display) ms. */
	displayTotalMs: number
	speed: number
	skipInactive: boolean
	isFullscreen: boolean
	markers: DisplayMarker[]
	idleBands: IdleBand[]
	/** Real⇄display mapping; used to align backend spans onto the timeline. */
	timeline: Timeline
	/** First rrweb event timestamp (ms-epoch) — span alignment time-zero. */
	recordingStartEpochMs: number
	/** Total length in rrweb's real clock (ms). */
	realTotalMs: number
	togglePlay(): void
	/** Seek to a position given in trimmed (display) ms. */
	seekDisplay(displayMs: number): void
	changeSpeed(s: number): void
	toggleSkipInactive(): void
	toggleFullscreen(): void
}

const ReplayPlayerContext = React.createContext<ReplayPlayerContextValue | null>(null)

export function useReplayPlayer(): ReplayPlayerContextValue {
	const ctx = React.useContext(ReplayPlayerContext)
	if (!ctx) throw new Error("useReplayPlayer must be used within a ReplayPlayerProvider")
	return ctx
}

const EMPTY_EVENTS: unknown[] = []

export function errorMessage(error: unknown): string {
	if (typeof error === "object" && error !== null && "message" in error) {
		const message = (error as { message: unknown }).message
		if (typeof message === "string") return message
	}
	return String(error)
}

export function ReplayPlayerProvider({
	sessionId,
	children,
}: {
	sessionId: string
	children: React.ReactNode
}) {
	// Two stages: signed chunk URLs, then the gunzipped blobs concatenated in order.
	const eventsResult = useAtomValue(getReplayEventsResultAtom({ data: { sessionId } }))
	const chunks = Result.builder(eventsResult)
		.onSuccess((events) => events.chunks as ReadonlyArray<ReplayChunkUrl>)
		.orElse(() => [] as ReadonlyArray<ReplayChunkUrl>)
	const blobResult = useAtomValue(replayChunkEventsAtom(replayChunkEventsKey(chunks)))

	// Resolve load status + a stable `events` reference (the atom's success value
	// is referentially stable while unchanged, so deriveMeta/engine memos hold).
	const { status, error, events } = React.useMemo<{
		status: ReplayLoadStatus
		error: unknown
		events: unknown[]
	}>(() => {
		return Result.builder(eventsResult)
			.onInitial(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
			.onError((e) => ({ status: "error" as const, error: e, events: EMPTY_EVENTS }))
			.onSuccess(() =>
				Result.builder(blobResult)
					.onInitial(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
					.onError((e) => ({ status: "error" as const, error: e, events: EMPTY_EVENTS }))
					.onSuccess((decoded) =>
						decoded.length >= 2
							? { status: "ready" as const, error: null, events: decoded as unknown[] }
							: { status: "empty" as const, error: null, events: EMPTY_EVENTS },
					)
					.orElse(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS })),
			)
			.orElse(() => ({ status: "loading" as const, error: null, events: EMPTY_EVENTS }))
	}, [eventsResult, blobResult])

	const figureRef = React.useRef<HTMLElement | null>(null)
	const surfaceRef = React.useRef<HTMLDivElement | null>(null)
	const mountRef = React.useRef<HTMLDivElement | null>(null)
	const replayerRef = React.useRef<Replayer | null>(null)

	const { recordedWidth, recordedHeight, startTime, actionMarkers, inactiveIntervals } =
		React.useMemo(() => deriveMeta(events), [events])

	const [isPlaying, setIsPlaying] = React.useState(false)
	const [finished, setFinished] = React.useState(false)
	const [currentMs, setCurrentMs] = React.useState(0)
	const [totalMs, setTotalMs] = React.useState(0)
	const [speed, setSpeed] = React.useState(1)
	const [skipInactive, setSkipInactive] = React.useState(true)
	const [isFullscreen, setIsFullscreen] = React.useState(false)
	const skipInactiveRef = React.useRef(skipInactive)
	skipInactiveRef.current = skipInactive
	const isFullscreenRef = React.useRef(isFullscreen)
	isFullscreenRef.current = isFullscreen

	// While skip-idle is on, present the timeline in active time: idle gaps
	// collapse so the clock/scrubber match the (already idle-skipping) playback.
	const timeline = React.useMemo(
		() => buildTimeline(skipInactive ? inactiveIntervals : [], totalMs),
		[inactiveIntervals, totalMs, skipInactive],
	)
	const displayCurrentMs = timeline.toDisplay(currentMs)
	const displayTotalMs = timeline.activeTotalMs
	const markers = React.useMemo<DisplayMarker[]>(
		() => actionMarkers.map((m) => ({ ms: timeline.toDisplay(m.ms), kind: m.kind })),
		[actionMarkers, timeline],
	)
	const idleBands = React.useMemo<IdleBand[]>(
		() =>
			inactiveIntervals.map((iv) => ({
				start: timeline.toDisplay(iv.start),
				end: timeline.toDisplay(iv.end),
			})),
		[inactiveIntervals, timeline],
	)

	// Fit the recorded viewport into the available width (or both dims when
	// fullscreen), centering the scaled wrapper.
	const applyScale = React.useCallback(() => {
		const replayer = replayerRef.current
		const container = surfaceRef.current
		if (!replayer || !container || !recordedWidth || !recordedHeight) return
		const availW = container.clientWidth
		if (!availW) return
		const fs = isFullscreenRef.current
		let scale: number
		let availH: number
		if (fs) {
			container.style.height = ""
			availH = container.clientHeight
			scale = Math.min(availW / recordedWidth, availH / recordedHeight)
		} else {
			scale = availW / recordedWidth
			availH = recordedHeight * scale
			container.style.height = `${Math.round(availH)}px`
		}
		const offsetX = Math.max(0, (availW - recordedWidth * scale) / 2)
		const offsetY = Math.max(0, (availH - recordedHeight * scale) / 2)
		replayer.wrapper.style.transformOrigin = "top left"
		replayer.wrapper.style.transform = `translate(${offsetX}px, ${offsetY}px) scale(${scale})`
	}, [recordedWidth, recordedHeight])

	// Mirror document fullscreen state so the surface rescales + the button swaps.
	React.useEffect(() => {
		const onChange = () => setIsFullscreen(document.fullscreenElement === figureRef.current)
		document.addEventListener("fullscreenchange", onChange)
		return () => document.removeEventListener("fullscreenchange", onChange)
	}, [])

	const toggleFullscreen = React.useCallback(() => {
		if (document.fullscreenElement) void document.exitFullscreen()
		else void figureRef.current?.requestFullscreen()
	}, [])

	// Mount the engine once events are ready. Keyed on `events` — a fresh session
	// rebuilds. The surface's mount div is committed before this parent effect runs.
	React.useEffect(() => {
		if (status !== "ready") return
		const mount = mountRef.current
		if (!mount) return
		mount.innerHTML = ""

		const accent =
			getComputedStyle(document.documentElement).getPropertyValue("--primary").trim() || "#6366f1"

		const replayer = new Replayer(events as never, {
			root: mount,
			speed: 1,
			// We skip idle ourselves by jumping (see the rAF loop) — rrweb's own
			// skipInactive only fast-forwards, which is slow. Keep it off.
			skipInactive: false,
			mouseTail: { duration: 600, lineCap: "round", lineWidth: 3, strokeStyle: accent },
			showWarning: false,
			showDebug: false,
			liveMode: false,
		})
		replayerRef.current = replayer
		setTotalMs(replayer.getMetaData().totalTime)
		setCurrentMs(0)
		setFinished(false)
		setIsPlaying(false)

		// rrweb's own transport events are unreliable in @rrweb/replay (Start/Resume
		// often don't fire); play/pause state is driven from our handlers. We still
		// honour Finish to flip back to the replay affordance at the end.
		replayer.on(ReplayerEvents.Finish, () => {
			setIsPlaying(false)
			setFinished(true)
		})

		const observer = new ResizeObserver(() => applyScale())
		if (surfaceRef.current) observer.observe(surfaceRef.current)
		applyScale()

		return () => {
			observer.disconnect()
			replayer.destroy()
			replayerRef.current = null
			mount.innerHTML = ""
		}
	}, [events, status, applyScale])

	// Recompute scale when entering/leaving fullscreen.
	React.useEffect(() => {
		applyScale()
	}, [isFullscreen, applyScale])

	// Poll the engine clock while playing (rrweb has no per-frame time event).
	// While skip-idle is on, jump straight over any inactive gap we land in.
	React.useEffect(() => {
		if (!isPlaying) return
		let raf = 0
		// Remember the gap we last jumped out of so we don't re-issue play() every
		// frame before the engine clock catches up (which would thrash pause/play).
		let lastJumpedEnd = -1
		const tick = () => {
			const replayer = replayerRef.current
			if (replayer) {
				const cur = replayer.getCurrentTime()
				const gap =
					skipInactiveRef.current &&
					inactiveIntervals.find((iv) => cur >= iv.start && cur < iv.end)
				if (gap && gap.end !== lastJumpedEnd) {
					lastJumpedEnd = gap.end
					// Explicit pause→play forces the engine to seek; play(offset) alone
					// can no-op while already playing in @rrweb/replay.
					replayer.pause(gap.end)
					replayer.play(gap.end)
					setCurrentMs(gap.end)
				} else if (!gap) {
					lastJumpedEnd = -1
					setCurrentMs(Math.min(cur, totalMs))
				}
			}
			raf = requestAnimationFrame(tick)
		}
		raf = requestAnimationFrame(tick)
		return () => cancelAnimationFrame(raf)
	}, [isPlaying, totalMs, inactiveIntervals])

	const togglePlay = React.useCallback(() => {
		const replayer = replayerRef.current
		if (!replayer) return
		if (finished) {
			replayer.play(0)
			setCurrentMs(0)
			setFinished(false)
			setIsPlaying(true)
		} else if (isPlaying) {
			replayer.pause()
			setIsPlaying(false)
		} else {
			const from = currentMs >= totalMs ? 0 : currentMs
			replayer.play(from)
			setIsPlaying(true)
		}
	}, [finished, isPlaying, currentMs, totalMs])

	const seekDisplay = React.useCallback(
		// `displayMs` arrives in trimmed-timeline space; map back to rrweb's real
		// clock before driving the engine.
		(displayMs: number) => {
			const replayer = replayerRef.current
			if (!replayer) return
			const clamped = Math.max(0, Math.min(timeline.toReal(displayMs), totalMs))
			setCurrentMs(clamped)
			if (clamped < totalMs) setFinished(false)
			if (isPlaying && clamped < totalMs) replayer.play(clamped)
			else replayer.pause(clamped)
		},
		[isPlaying, totalMs, timeline],
	)

	const changeSpeed = React.useCallback((next: number) => {
		setSpeed(next)
		replayerRef.current?.setConfig({ speed: next })
	}, [])

	const toggleSkipInactive = React.useCallback(() => {
		setSkipInactive((prev) => !prev)
	}, [])

	const value = React.useMemo<ReplayPlayerContextValue>(
		() => ({
			status,
			error,
			figureRef,
			surfaceRef,
			mountRef,
			recordedWidth,
			recordedHeight,
			isPlaying,
			finished,
			displayCurrentMs,
			displayTotalMs,
			speed,
			skipInactive,
			isFullscreen,
			markers,
			idleBands,
			timeline,
			recordingStartEpochMs: startTime,
			realTotalMs: totalMs,
			togglePlay,
			seekDisplay,
			changeSpeed,
			toggleSkipInactive,
			toggleFullscreen,
		}),
		[
			status,
			error,
			recordedWidth,
			recordedHeight,
			isPlaying,
			finished,
			displayCurrentMs,
			displayTotalMs,
			speed,
			skipInactive,
			isFullscreen,
			markers,
			idleBands,
			timeline,
			startTime,
			totalMs,
			togglePlay,
			seekDisplay,
			changeSpeed,
			toggleSkipInactive,
			toggleFullscreen,
		],
	)

	return <ReplayPlayerContext.Provider value={value}>{children}</ReplayPlayerContext.Provider>
}
