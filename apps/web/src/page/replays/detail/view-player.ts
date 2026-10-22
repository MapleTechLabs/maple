import { formatClock } from "@maple/ui/lib/replay-format"
import { hostFromUrl } from "@maple/ui/lib/replay"
import { TONE_SOFT } from "@maple/ui/lib/tone"
import { cn } from "@maple/ui/lib/utils"
import { Option } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { button } from "../../../ui/button"
import { filterChip } from "../../../ui/filter-chip"
import { icon } from "../../../ui/icon"
import { iconButton } from "../../../ui/icon-button"
import { panel } from "../../../ui/panel"
import { segmentedSelect } from "../../../ui/segmented-select"
import { spinner } from "../../../ui/spinner"
import { docsLink } from "../../kit/signal-empty-state"
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
import { type PlayerStatus, timelineOf } from "./derive"
import { isBuffering, seedEvents, seedShiftMs, trailingRanges } from "./loader"
import { Message } from "./message"
import type { Model, ReplayDetail } from "./model"
import type { LoadFailure } from "../../../data/load-failure"

// The replay surface and its transport controls.
// TODO(scrubber-drag): the scrubber seeks on pointer down; drag-to-scrub and the hover time bubble
// are not ported.

type H = HtmlBuilder<Message>

const SPEED_OPTIONS = [0.5, 1, 2, 4, 8].map((s) => ({ value: String(s), label: `${s}×` }))

export type DisplayState = Readonly<{
	currentMs: number
	totalMs: number
	markers: ReadonlyArray<{ readonly ms: number; readonly kind: keyof typeof MARKER_STYLES }>
	idleBands: ReadonlyArray<{ readonly start: number; readonly end: number }>
}>

/** The playhead, markers and idle bands on the trimmed (display) timeline. */
export const displayState = (model: Model): DisplayState => {
	const timeline = timelineOf(model)
	return {
		currentMs: timeline.toDisplay(model.player.currentMs),
		totalMs: timeline.activeTotalMs,
		markers: model.meta.actionMarkers.map((marker) => ({
			ms: timeline.toDisplay(marker.ms),
			kind: marker.kind,
		})),
		idleBands: model.meta.inactiveIntervals.map((interval) => ({
			start: timeline.toDisplay(interval.start),
			end: timeline.toDisplay(interval.end),
		})),
	}
}

const IDLE_HATCH = "repeating-linear-gradient(45deg, transparent 0 2px, rgba(0,0,0,0.18) 2px 4px)"

export const idleBandsLayer = (h: H, display: DisplayState): ReadonlyArray<Html> =>
	display.totalMs <= 0
		? []
		: display.idleBands.map((band, i) => {
				const leftPct = Math.max(0, Math.min(100, (band.start / display.totalMs) * 100))
				const widthPct = Math.max(
					0,
					Math.min(100 - leftPct, ((band.end - band.start) / display.totalMs) * 100),
				)
				return h.span(
					[
						h.Key(`idle-${band.start}-${i}`),
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
			})

export const markersLayer = (h: H, display: DisplayState): ReadonlyArray<Html> =>
	display.totalMs <= 0
		? []
		: display.markers.map((marker, i) =>
				h.span(
					[
						h.Key(`${marker.kind}-${marker.ms}-${i}`),
						h.Class(
							cn(
								"absolute top-1/2 size-1.5 -translate-x-1/2 -translate-y-1/2 rounded-full ring-1 ring-card",
								MARKER_STYLES[marker.kind],
							),
						),
						h.Style({
							left: `${Math.min(100, Math.max(0, (marker.ms / display.totalMs) * 100))}%`,
						}),
						h.Title(marker.kind),
					],
					[],
				),
			)

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
									? "Recording in progress — frames appear as chunks finish uploading."
									: "This recording is too short to play back.",
							],
							sessionActive,
						)
					: playerMessage(h, [
							"This session wasn’t recorded. Replay is off or unsampled for this app. Its traces and events are still below.",
							h.span([h.Class("mt-2 flex justify-center")], [docsLink(h, "sessionReplay")]),
						])
	return h.div([h.Class("absolute inset-0 bg-muted/30")], [body])
}

/** The engine's element, keyed by its seed so a new seed mounts a new engine; the Model drives it. */
const engineMount = (h: H, model: Model, session: ReplayDetail, status: PlayerStatus): Html => {
	const { player, loader } = model
	const attributes = [
		h.Class("absolute inset-0"),
		h.DataAttribute(CONTROL_ATTRIBUTE, player.control),
		h.DataAttribute(SPEED_ATTRIBUTE, String(player.speed)),
		h.DataAttribute(
			IDLE_ATTRIBUTE,
			JSON.stringify(player.isSkippingIdle ? model.meta.inactiveIntervals : []),
		),
		h.DataAttribute(HOLD_ATTRIBUTE, String(player.isPlaying && isBuffering(model))),
		h.DataAttribute(TOTAL_ATTRIBUTE, String(player.totalMs)),
	]
	return status === "ready"
		? h.div(
				[
					h.Key(`engine-${loader.seedVersion}`),
					...attributes,
					h.OnMount(
						MountEngine({
							seedVersion: loader.seedVersion,
							events: seedEvents(loader),
							format: replayFormat(session.resourceAttributes),
							startAtMs: loader.seekTargetMs,
							shiftMs: seedShiftMs(loader),
						}),
					),
				],
				[],
			)
		: h.div([h.Key("engine-idle"), ...attributes], [])
}

const playOverlay = (h: H, model: Model): Html => {
	const { player } = model
	return h.div(
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
							player.isPlaying ? "opacity-0 group-hover:opacity-70" : "opacity-100",
						),
					),
				],
				[
					player.isFinished
						? icon(h, "ArrowPathIcon", { className: "size-7" })
						: player.isPlaying
							? icon(h, "MediaPauseIcon", { className: "size-7" })
							: icon(h, "MediaPlayIcon", { className: "size-7 translate-x-0.5" }),
				],
			),
		],
	)
}

/** `ReplaySurface detachedTransport docked`: browser chrome over the recording. */
export const replaySurface = (
	h: H,
	model: Model,
	session: ReplayDetail,
	state: Readonly<{ status: PlayerStatus; failure: LoadFailure | null; sessionActive: boolean }>,
): Html => {
	const { isFullscreen } = model.player
	const overlay = statusOverlay(h, state.status, state.failure, state.sessionActive)
	return panel(
		h,
		{
			className: cn(
				"block shadow-sm",
				"rounded-b-none shadow-none",
				isFullscreen && "flex h-screen w-screen flex-col rounded-none border-0 bg-black",
			),
			attributes: [h.DataAttribute("replay-figure", "")],
		},
		[
			h.div(
				[h.Class("flex items-center gap-3 border-b border-border bg-muted/40 px-3.5 py-2.5")],
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
							icon(h, "GlobeIcon", { className: "size-3.5 shrink-0 opacity-70" }),
							h.span(
								[h.Class("truncate font-mono")],
								[session.urlInitial ? hostFromUrl(session.urlInitial) : "about:blank"],
							),
						],
					),
				],
			),
			h.div(
				[
					h.Class(
						cn(
							"relative w-full overflow-hidden bg-neutral-900",
							isFullscreen ? "min-h-0 flex-1" : "aspect-video",
						),
					),
				],
				[
					engineMount(h, model, session, state.status),
					...(state.status === "ready" ? [playOverlay(h, model)] : []),
					...(overlay === null ? [] : [overlay]),
					...trailingRanges(model.loader).map((range) =>
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
			),
			...(isFullscreen && state.status !== "unrecorded" ? [replayControls(h, model, false)] : []),
		],
	)
}

/** `Scrubber`: a pointer press seeks to where it lands. */
const scrubber = (h: H, display: DisplayState): Html => {
	const pct = display.totalMs > 0 ? Math.min(100, (display.currentMs / display.totalMs) * 100) : 0
	return h.div(
		[
			h.Role("slider"),
			h.AriaLabel("Seek"),
			h.AriaValuemin(0),
			h.AriaValuemax(Math.round(display.totalMs)),
			h.AriaValuenow(Math.round(display.currentMs)),
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
					...idleBandsLayer(h, display),
					h.div(
						[h.Class("relative h-full rounded-full bg-primary"), h.Style({ width: `${pct}%` })],
						[],
					),
				],
			),
			...markersLayer(h, display),
			h.div(
				[
					h.Class(
						"absolute top-1/2 size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-primary bg-background opacity-0 shadow-sm transition-opacity group-hover:opacity-100 pointer-coarse:opacity-100",
					),
					h.Style({ left: `${pct}%` }),
				],
				[],
			),
		],
	)
}

/** `ReplayControls`: play, scrubber, clock, speed, skip idle, fullscreen. */
export const replayControls = (h: H, model: Model, isDetached: boolean): Html => {
	const { player } = model
	const display = displayState(model)
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
					iconButton(
						h,
						{
							label: player.isFinished ? "Replay" : player.isPlaying ? "Pause" : "Play",
							variant: "default",
							size: "icon",
							className: "rounded-full before:rounded-full",
							attributes: [h.AriaKeyshortcuts("Space"), h.OnClick(Message.ClickedPlay())],
						},
						[
							player.isFinished
								? icon(h, "ArrowPathIcon")
								: player.isPlaying
									? icon(h, "MediaPauseIcon")
									: icon(h, "MediaPlayIcon", { className: "translate-x-px" }),
						],
					),
					scrubber(h, display),
					h.div(
						[
							h.Class(
								"flex shrink-0 items-center gap-1 font-mono text-xs tabular-nums text-muted-foreground",
							),
						],
						[
							h.span([h.Class("text-foreground")], [formatClock(display.currentMs)]),
							h.span([h.Class("opacity-50")], ["/"]),
							h.span([], [formatClock(display.totalMs)]),
						],
					),
				],
			),
			h.div(
				[h.Class("flex items-center gap-2 sm:contents")],
				[
					segmentedSelect(h, {
						size: "sm",
						ariaLabel: "Playback speed",
						className: "shrink-0",
						options: SPEED_OPTIONS,
						value: String(player.speed),
						onChange: (value) => Message.PickedSpeed({ speed: Number(value) }),
					}),
					filterChip(
						h,
						{ size: "xs", isPressed: player.isSkippingIdle, onClick: Message.ToggledSkipIdle() },
						["Skip idle"],
					),
					iconButton(
						h,
						{
							label: player.isFullscreen ? "Exit fullscreen" : "Enter fullscreen",
							size: "icon",
							className: "text-muted-foreground hover:text-foreground max-sm:ml-auto",
							attributes: [h.OnClick(Message.ClickedFullscreen())],
						},
						[icon(h, player.isFullscreen ? "MinimizeIcon" : "MaximizeIcon")],
					),
				],
			),
		],
	)
}

/** `ReplayTransport docked`: the controls flush under the surface (hidden in fullscreen). */
export const replayTransport = (h: H, model: Model, status: PlayerStatus): Html | null =>
	model.player.isFullscreen || status === "unrecorded"
		? null
		: panel(h, { className: "rounded-t-none border-t-0" }, [replayControls(h, model, true)])
