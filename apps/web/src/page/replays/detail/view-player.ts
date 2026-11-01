import { formatClock } from "@maple/ui/lib/replay-format"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import { createKeyedLazy, createLazy, type Html, type HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { filterChip } from "../../../ui/filter-chip"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { panel } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { spinner } from "../../../ui/spinner"
import { docsLink } from "../../kit/signal-empty-state"
import { stableSlice } from "../../kit/stable-slice"
import {
	CONTROL_ATTRIBUTE,
	HOLD_ATTRIBUTE,
	IDLE_ATTRIBUTE,
	SPEED_ATTRIBUTE,
	TOTAL_ATTRIBUTE,
} from "../kit/replay-engine-mount"
import { MARKER_STYLES } from "../kit/replay-meta"
import { replayFormat } from "../kit/replay-window"
import { FeedEvents, MountEngine } from "./command"
import { type PlayerStatus, timelineFrom, timelineOf } from "./derive"
import { isBuffering, seedEvents, seedShiftMs, trailingRanges } from "./loader"
import { Message } from "./message"
import type { Model, ReplayDetail } from "./model"
import type { LoadFailure } from "../../../data/load-failure"

// The replay surface and its transport controls.
// TODO(scrubber-drag): the scrubber seeks on pointer down; drag-to-scrub and the hover time bubble
// are not ported.

type H = HtmlBuilder<Message>

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8].map((s) => ({ value: String(s), label: `${s}×` }))

/** The playhead on the trimmed (display) timeline: the only part a playback tick moves. */
export type Playhead = Readonly<{ currentMs: number; totalMs: number }>

export const playheadOf = (model: Model): Playhead => {
	const timeline = timelineOf(model)
	return { currentMs: timeline.toDisplay(model.player.currentMs), totalMs: timeline.activeTotalMs }
}

type Marker = Model["meta"]["actionMarkers"][number]
type Interval = Model["meta"]["inactiveIntervals"][number]

const IDLE_HATCH = "repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,0.18) 2px 4px)"

const idleBandsView = (
	h: H,
	intervals: ReadonlyArray<Interval>,
	totalMs: number,
	isSkippingIdle: boolean,
): Html => {
	const timeline = timelineFrom({ inactiveIntervals: intervals, totalMs, isSkippingIdle })
	const total = timeline.activeTotalMs
	return h.div(
		[h.Class("absolute inset-0")],
		total <= 0
			? []
			: intervals.map((interval, i) => {
					const start = timeline.toDisplay(interval.start)
					const leftPct = Math.max(0, Math.min(100, (start / total) * 100))
					const widthPct = Math.max(
						0,
						Math.min(100 - leftPct, ((timeline.toDisplay(interval.end) - start) / total) * 100),
					)
					return h.span(
						[
							h.Key(`idle-${start}-${i}`),
							h.Class("absolute inset-y-0 bg-foreground/25"),
							h.Style({
								left: `${leftPct}%`,
								width: `${widthPct}%`,
								"min-width": "3px",
								"background-image": IDLE_HATCH,
							}),
							h.Title("Idle"),
						],
						[],
					)
				}),
	)
}

const markersView = (
	h: H,
	markers: ReadonlyArray<Marker>,
	intervals: ReadonlyArray<Interval>,
	totalMs: number,
	isSkippingIdle: boolean,
): Html => {
	const timeline = timelineFrom({ inactiveIntervals: intervals, totalMs, isSkippingIdle })
	const total = timeline.activeTotalMs
	return h.div(
		[h.Class("absolute inset-0")],
		total <= 0
			? []
			: markers.map((marker, i) => {
					const ms = timeline.toDisplay(marker.ms)
					return h.span(
						[
							h.Key(`${marker.kind}-${ms}-${i}`),
							h.Class(
								cn(
									"absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-card",
									MARKER_STYLES[marker.kind],
								),
							),
							h.Style({ left: `${Math.min(100, Math.max(0, (ms / total) * 100))}%` }),
							h.Title(marker.kind),
						],
						[],
					)
				}),
	)
}

// The tracks change with the recording, not the playhead: one cache entry per surface they sit on.
const trackSlots = createKeyedLazy()

export type TrackSurface = "docked" | "fullscreen" | "timeline"

export const idleBandsTrack = (h: H, model: Model, surface: TrackSurface): Html =>
	trackSlots(`idle-${surface}`, idleBandsView, [
		h,
		model.meta.inactiveIntervals,
		model.player.totalMs,
		model.player.isSkippingIdle,
	])

export const markersTrack = (h: H, model: Model, surface: TrackSurface): Html =>
	trackSlots(`markers-${surface}`, markersView, [
		h,
		model.meta.actionMarkers,
		model.meta.inactiveIntervals,
		model.player.totalMs,
		model.player.isSkippingIdle,
	])

/** `PlayerMessage`: the surface's centred note when there is nothing to play. */
const playerMessage = (h: H, children: ReadonlyArray<Html | string>, hasSpinner = false): Html =>
	h.div(
		[h.Class("flex aspect-video w-full items-center justify-center p-8")],
		[
			h.div(
				[h.Class("flex max-w-sm flex-col items-center gap-3 text-center")],
				[
					h.div(
						[
							h.Class(
								"grid size-11 place-items-center rounded-full bg-muted text-muted-foreground",
							),
						],
						[hasSpinner ? spinner(h, "size-5") : icon(h, "EyeIcon", { className: "size-5" })],
					),
					h.p([h.Class("text-sm leading-relaxed text-muted-foreground")], children),
				],
			),
		],
	)

/** `PlayerError`: the failure in the app's error contract, retry when it can help. */
const playerError = (h: H, failure: LoadFailure): Html => {
	const canRetry = failure.recovery === "retry" || failure.recovery === "refresh"
	return h.div(
		[h.Class("flex aspect-video w-full items-center justify-center p-8")],
		[
			h.div(
				[
					h.Class("flex max-w-sm flex-col items-center gap-3 text-center"),
					h.Role("alert"),
					h.AriaLive("polite"),
				],
				[
					h.div(
						[h.Class(cn("grid size-11 place-items-center rounded-full", TONE_SOFT.crit))],
						[icon(h, "EyeIcon", { className: "size-5" })],
					),
					h.div(
						[h.Class("space-y-1")],
						[
							h.p([h.Class("text-sm font-medium text-muted-foreground")], [failure.title]),
							h.p(
								[h.Class("text-sm leading-relaxed text-muted-foreground")],
								[failure.message],
							),
						],
					),
					...(canRetry
						? [
								button(
									h,
									{
										size: "sm",
										variant: "outline",
										attributes: [h.OnClick(Message.ClickedRetryPlayer())],
									},
									["Try again"],
								),
							]
						: []),
				],
			),
		],
	)
}

const statusOverlay = (
	h: H,
	status: PlayerStatus,
	failure: LoadFailure | null,
	sessionActive: boolean,
): Html | null => {
	if (status === "ready") return null
	const body =
		status === "loading"
			? playerMessage(h, ["Loading replay…"], true)
			: status === "error" && failure !== null
				? playerError(h, failure)
				: status === "empty"
					? playerMessage(
							h,
							[
								sessionActive
									? "Recording in progress. Frames appear as chunks finish uploading."
									: "This recording is too short to play back.",
							],
							sessionActive,
						)
					: playerMessage(h, [
							"This session wasn’t recorded. Replay is off or unsampled for this app. Its traces and events are still below.",
							h.span([h.Class("mt-2 flex justify-center")], [docsLink(h, "sessionReplay")]),
						])
	return h.div([h.Class("absolute inset-0 bg-surface-sunken")], [body])
}

/** What the stage reads: everything but the playhead, so a tick reuses it. */
const stageOf = stableSlice((model: Model) => ({
	control: model.player.control,
	speed: model.player.speed,
	isSkippingIdle: model.player.isSkippingIdle,
	isPlaying: model.player.isPlaying,
	isFinished: model.player.isFinished,
	isFullscreen: model.player.isFullscreen,
	totalMs: model.player.totalMs,
	inactiveIntervals: model.meta.inactiveIntervals,
	seedVersion: model.loader.seedVersion,
	seed: model.loader.seed,
	seekTargetMs: model.loader.seekTargetMs,
	originMs: model.loader.originMs,
	seedCount: model.loader.seedCount,
	loaded: model.loader.loaded,
}))
type Stage = ReturnType<typeof stageOf>

type SurfaceState = Readonly<{ status: PlayerStatus; failure: LoadFailure | null; sessionActive: boolean }>

/** The engine's element, keyed by its seed so a new seed mounts a new engine; the Model drives it. */
const engineMount = (
	h: H,
	stage: Stage,
	session: ReplayDetail,
	status: PlayerStatus,
	isHolding: boolean,
): Html => {
	const attributes = [
		h.Class("absolute inset-0"),
		h.DataAttribute(CONTROL_ATTRIBUTE, stage.control),
		h.DataAttribute(SPEED_ATTRIBUTE, String(stage.speed)),
		h.DataAttribute(IDLE_ATTRIBUTE, JSON.stringify(stage.isSkippingIdle ? stage.inactiveIntervals : [])),
		h.DataAttribute(HOLD_ATTRIBUTE, String(isHolding)),
		h.DataAttribute(TOTAL_ATTRIBUTE, String(stage.totalMs)),
	]
	return status === "ready"
		? h.div(
				[
					h.Key(`engine-${stage.seedVersion}`),
					...attributes,
					h.OnMount(
						MountEngine({
							seedVersion: stage.seedVersion,
							events: seedEvents(stage),
							format: replayFormat(session.resourceAttributes),
							startAtMs: stage.seekTargetMs,
							shiftMs: seedShiftMs(stage),
						}),
					),
				],
				[],
			)
		: h.div([h.Key("engine-idle"), ...attributes], [])
}

const playOverlay = (h: H, stage: Stage): Html =>
	h.div(
		[
			h.AriaHidden(true),
			h.OnClick(Message.ClickedPlay()),
			h.Class("group absolute inset-0 grid cursor-pointer place-items-center"),
		],
		[
			h.span(
				[
					h.Class(
						cn(
							"grid size-16 place-items-center rounded-full bg-black/55 text-white backdrop-blur-sm transition-opacity duration-200",
							stage.isPlaying ? "opacity-0 group-hover:opacity-70" : "opacity-100",
						),
					),
				],
				[
					stage.isFinished
						? icon(h, "ArrowPathIcon", { className: "size-7" })
						: stage.isPlaying
							? icon(h, "MediaPauseIcon", { className: "size-7" })
							: icon(h, "MediaPlayIcon", { className: "size-7 translate-x-0.5" }),
				],
			),
		],
	)

const urlBar = (h: H, urlInitial: string): Html =>
	h.div(
		[h.Class("flex items-center gap-3 border-b border-border bg-surface-sunken px-3.5 py-2.5")],
		[
			h.div(
				[h.Class("flex items-center gap-1.5"), h.AriaHidden(true)],
				[
					h.span([h.Class("size-3 rounded-full bg-[#ff5f57]")], []),
					h.span([h.Class("size-3 rounded-full bg-[#febc2e]")], []),
					h.span([h.Class("size-3 rounded-full bg-[#28c840]")], []),
				],
			),
			h.div(
				[
					h.Class(
						"flex min-w-0 flex-1 items-center gap-2 rounded-md bg-background/80 px-2.5 py-1 text-xs text-muted-foreground ring-1 ring-inset ring-border",
					),
				],
				[
					icon(h, "GlobeIcon", { className: "size-3.5 shrink-0" }),
					h.span(
						[h.Class("truncate font-mono")],
						[urlInitial ? hostFromUrl(urlInitial) : "about:blank"],
					),
				],
			),
		],
	)

const stageView = (
	h: H,
	stage: Stage,
	session: ReplayDetail,
	status: PlayerStatus,
	failure: LoadFailure | null,
	sessionActive: boolean,
	isHolding: boolean,
): Html => {
	const overlay = statusOverlay(h, status, failure, sessionActive)
	return h.div(
		[
			h.Class(
				cn(
					"relative w-full overflow-hidden bg-neutral-900",
					stage.isFullscreen ? "min-h-0 flex-1" : "aspect-video",
				),
			),
		],
		[
			engineMount(h, stage, session, status, isHolding),
			...(status === "ready" ? [playOverlay(h, stage)] : []),
			...(overlay === null ? [] : [overlay]),
			...trailingRanges(stage).map((range) =>
				h.span(
					[
						h.Key(`feed-${range.key}`),
						h.Hidden(true),
						h.OnMount(FeedEvents({ events: range.events })),
					],
					[],
				),
			),
		],
	)
}

const urlBarSlot = createLazy()
const stageSlot = createLazy()

/** `ReplaySurface detachedTransport docked`: browser chrome over the recording. */
export const replaySurface = (h: H, model: Model, session: ReplayDetail, state: SurfaceState): Html => {
	const { isFullscreen } = model.player
	const isHolding = model.player.isPlaying && isBuffering(model)
	return panel(
		h,
		{
			className: cn(
				"block shadow-raised",
				"rounded-b-none shadow-none",
				isFullscreen && "flex h-screen w-screen flex-col rounded-none border-0 bg-black",
			),
			attributes: [h.DataAttribute("replay-figure", "")],
		},
		[
			urlBarSlot(urlBar, [h, session.urlInitial]),
			stageSlot(stageView, [
				h,
				stageOf(model),
				session,
				state.status,
				state.failure,
				state.sessionActive,
				isHolding,
			]),
			...(isFullscreen && state.status !== "unrecorded" ? [replayControls(h, model, false)] : []),
		],
	)
}

/** `Scrubber`: a pointer press seeks to where it lands. */
const scrubber = (h: H, model: Model, surface: TrackSurface): Html => {
	const playhead = playheadOf(model)
	const pct = playhead.totalMs > 0 ? Math.min(100, (playhead.currentMs / playhead.totalMs) * 100) : 0
	return h.div(
		[
			h.Role("slider"),
			h.AriaLabel("Seek"),
			h.AriaValuemin(0),
			h.AriaValuemax(Math.round(playhead.totalMs)),
			h.AriaValuenow(Math.round(playhead.currentMs)),
			h.Tabindex(0),
			h.DataAttribute("replay-scrub", "transport"),
			h.OnPointerDown((_type, _button, _screenX, _screenY, _time, clientX) =>
				Option.some(Message.PressedScrubber({ surface: "transport", clientX })),
			),
			h.Class("group relative h-6 flex-1 cursor-pointer touch-none select-none"),
		],
		[
			h.div(
				[
					h.Class(
						"absolute inset-x-0 top-1/2 h-1.5 -translate-y-1/2 overflow-hidden rounded-full bg-muted",
					),
				],
				[
					idleBandsTrack(h, model, surface),
					h.div(
						[h.Class("relative h-full rounded-full bg-primary"), h.Style({ width: `${pct}%` })],
						[],
					),
				],
			),
			markersTrack(h, model, surface),
			h.div(
				[
					h.Class(
						"absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-raised transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100",
					),
					h.Style({ left: `${pct}%` }),
				],
				[],
			),
		],
	)
}

const playButton = (h: H, isPlaying: boolean, isFinished: boolean): Html =>
	iconButton(
		h,
		{
			label: isFinished ? "Replay" : isPlaying ? "Pause" : "Play",
			variant: "default",
			size: "icon",
			className: "rounded-full before:rounded-full",
			attributes: [h.AriaKeyshortcuts("Space"), h.OnClick(Message.ClickedPlay())],
		},
		[
			isFinished
				? icon(h, "ArrowPathIcon")
				: isPlaying
					? icon(h, "MediaPauseIcon")
					: icon(h, "MediaPlayIcon", { className: "translate-x-px" }),
		],
	)

const settings = (h: H, speed: number, isSkippingIdle: boolean, isFullscreen: boolean): Html =>
	h.div(
		[h.Class("flex items-center gap-2 sm:contents")],
		[
			segmentedSelect(h, {
				size: "sm",
				ariaLabel: "Playback speed",
				className: "shrink-0",
				options: SPEED_OPTIONS,
				value: String(speed),
				onChange: (value) => Message.PickedSpeed({ speed: Number(value) }),
			}),
			filterChip(h, { size: "xs", isPressed: isSkippingIdle, onClick: Message.ToggledSkipIdle() }, [
				"Skip idle",
			]),
			iconButton(
				h,
				{
					label: isFullscreen ? "Exit fullscreen" : "Enter fullscreen",
					size: "icon",
					className:
						"text-muted-foreground hover:text-foreground active:text-foreground max-sm:ml-auto",
					attributes: [h.OnClick(Message.ClickedFullscreen())],
				},
				[icon(h, isFullscreen ? "MinimizeIcon" : "MaximizeIcon")],
			),
		],
	)

const controlSlots = createKeyedLazy()

/** `ReplayControls`: play, scrubber, clock, speed, skip idle, fullscreen. */
export const replayControls = (h: H, model: Model, isDetached: boolean): Html => {
	const { player } = model
	const surface = isDetached ? "docked" : "fullscreen"
	const playhead = playheadOf(model)
	return h.div(
		[
			h.Class(
				cn(
					"flex flex-col gap-2 bg-card px-3 py-2.5 sm:flex-row sm:items-center sm:gap-3",
					!isDetached && "border-t border-border",
				),
			),
		],
		[
			h.div(
				[h.Class("flex items-center gap-3 sm:contents")],
				[
					controlSlots(`play-${surface}`, playButton, [h, player.isPlaying, player.isFinished]),
					scrubber(h, model, surface),
					h.div(
						[
							h.Class(
								"flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground",
							),
						],
						[
							h.span([h.Class("text-foreground")], [formatClock(playhead.currentMs)]),
							h.span([h.Class("opacity-50")], ["/"]),
							h.span([], [formatClock(playhead.totalMs)]),
						],
					),
				],
			),
			controlSlots(`settings-${surface}`, settings, [
				h,
				player.speed,
				player.isSkippingIdle,
				player.isFullscreen,
			]),
		],
	)
}

/** `ReplayTransport docked`: the controls flush under the surface (hidden in fullscreen). */
export const replayTransport = (h: H, model: Model, status: PlayerStatus): Html | null =>
	model.player.isFullscreen || status === "unrecorded"
		? null
		: panel(h, { className: "rounded-t-none border-t-0" }, [replayControls(h, model, true)])
