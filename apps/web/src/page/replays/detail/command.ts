import { TraceId } from "@maple/domain/http"
import {
	getReplay,
	getReplayEvents,
	getReplayManifest,
	getSessionTranscript,
	getSessionTraceSummaries,
} from "@maple/web-data/warehouse/replays"
import { getSpanHierarchy } from "@maple/web-data/warehouse/traces"
import { Clock, Effect, Option, Queue, Result, Schedule, Schema, Stream } from "effect"
import { isDialogOpen, isEditableTarget } from "@maple/ui/lib/keyboard"
import { Command, Mount } from "foldkit"
import { IdleTtl } from "../../../data/idle-ttl"
import { toLoadFailure } from "../../../data/load-failure"
import { readThrough } from "../../../data/read-cache"
import { REPLAY_EVENTS, runReplayEngine } from "../kit/replay-engine-mount"
import { Message } from "./message"
import { EventRow, Manifest, ReplayDetail } from "./model"

// The detail page's reads, each carrying its request key back (S6), and the player Mounts.

const Window = {
	windowStart: Schema.optional(Schema.String),
	windowEnd: Schema.optional(Schema.String),
}

export const ResolveClock = Command.define("ResolveReplayClock", {
	messages: [Message.CompletedResolveClock],
	execute: Effect.map(Clock.currentTimeMillis, (nowMs) => Message.CompletedResolveClock({ nowMs })),
})

export const FetchDetail = Command.define("FetchReplayDetail", {
	args: { key: Schema.String, refresh: Schema.Boolean, sessionId: Schema.String, ...Window },
	messages: [Message.CompletedFetchDetail],
	execute: ({ key, refresh, sessionId, windowStart, windowEnd }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.replay, schema: Schema.NullOr(ReplayDetail) },
			Effect.map(
				getReplay({ data: { sessionId, windowStart, windowEnd } }),
				(response) => response.data,
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchDetail({ key, result })),
		),
})

export const FetchManifest = Command.define("FetchReplayManifest", {
	args: { key: Schema.String, refresh: Schema.Boolean, sessionId: Schema.String, ...Window },
	messages: [Message.CompletedFetchManifest],
	execute: ({ key, refresh, sessionId, windowStart, windowEnd }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.replayManifest, schema: Manifest },
			Effect.map(getReplayManifest({ data: { sessionId, windowStart, windowEnd } }), (manifest) => ({
				chunks: manifest.chunks,
				maxBytesPerRequest: manifest.max_bytes_per_request,
				maxChunksPerRequest: manifest.max_chunks_per_request,
			})),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchManifest({ key, result })),
		),
})

export const FetchTranscript = Command.define("FetchReplayTranscript", {
	args: { key: Schema.String, refresh: Schema.Boolean, sessionId: Schema.String, ...Window },
	messages: [Message.CompletedFetchTranscript],
	execute: ({ key, refresh, sessionId, windowStart, windowEnd }) =>
		readThrough(
			{ key, refresh, idleTtlMs: IdleTtl.sessionTranscript, schema: Schema.Array(EventRow) },
			Effect.map(
				getSessionTranscript({ data: { sessionId, windowStart, windowEnd } }),
				(response) => response.data,
			),
		).pipe(
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTranscript({ key, result })),
		),
})

export const FetchTraceSummaries = Command.define("FetchReplayTraceSummaries", {
	args: { key: Schema.String, traceIds: Schema.Array(Schema.String), ...Window },
	messages: [Message.CompletedFetchTraceSummaries],
	execute: ({ key, traceIds, windowStart, windowEnd }) =>
		getSessionTraceSummaries({ data: { traceIds, windowStart, windowEnd } }).pipe(
			Effect.map((response) => response.data),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchTraceSummaries({ key, result })),
		),
})

/** `decodeRange`'s per-chunk parse: a malformed chunk is skipped, not fatal. */
const decodeChunk = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Array(Schema.Unknown)))

export const FetchRange = Command.define("FetchReplayRange", {
	args: {
		key: Schema.String,
		sessionId: Schema.String,
		fromChunkSeq: Schema.Number,
		toChunkSeq: Schema.Number,
		...Window,
	},
	messages: [Message.CompletedFetchRange],
	execute: ({ key, ...data }) =>
		getReplayEvents({ data }).pipe(
			Effect.map((response) =>
				response.chunks.map((chunk) => ({
					chunk_seq: chunk.chunk_seq,
					events: Option.getOrElse(decodeChunk(chunk.events), () => []),
				})),
			),
			Effect.mapError(toLoadFailure),
			Effect.result,
			Effect.map((result) => Message.CompletedFetchRange({ key, result })),
		),
})

const decodeTraceId = Schema.decodeUnknownOption(TraceId)

/** `TraceSpanLane`: an expanded trace row's spans, fetched when it opens. */
export const FetchSpans = Command.define("FetchReplayTraceSpans", {
	args: { traceId: Schema.String, timestamp: Schema.String },
	messages: [Message.CompletedFetchSpans],
	execute: ({ traceId, timestamp }) =>
		Option.match(decodeTraceId(traceId), {
			onNone: () =>
				Effect.succeed(
					Message.CompletedFetchSpans({ traceId, result: Result.succeed([]) }),
				),
			onSome: (id) =>
				getSpanHierarchy({ data: { traceId: id, timestamp } }).pipe(
					Effect.map((response) =>
						response.spans.map((span) => ({
							spanId: span.spanId,
							spanName: span.spanName,
							serviceName: span.serviceName,
							startTime: span.startTime,
							durationMs: span.durationMs,
							statusCode: span.statusCode,
							spanAttributes: span.spanAttributes,
							spanKind: span.spanKind,
						})),
					),
					Effect.mapError(toLoadFailure),
					Effect.result,
					Effect.map((result) => Message.CompletedFetchSpans({ traceId, result })),
				),
		}),
})

type EngineMessage =
	| typeof Message.ReadiedEngine.Type
	| typeof Message.TickedEngine.Type
	| typeof Message.FinishedEngine.Type
	| typeof Message.StarvedEngine.Type

/** The engine for one seed; the element is keyed by `seedVersion`, so a new seed is a new engine. */
export const MountEngine = Mount.defineStream("MountReplayEngine", {
	args: {
		seedVersion: Schema.Number,
		events: Schema.Array(Schema.Unknown),
		format: Schema.Literals(["rrweb", "video"]),
		startAtMs: Schema.NullOr(Schema.Number),
		shiftMs: Schema.Number,
	},
	messages: [Message.ReadiedEngine, Message.TickedEngine, Message.FinishedEngine, Message.StarvedEngine],
	execute: ({ element, seedVersion, events, format, startAtMs, shiftMs }) =>
		runReplayEngine<EngineMessage>(
			element,
			{ events, format, startAtMs, shiftMs },
			{
				ready: (totalMs) => Message.ReadiedEngine({ seedVersion, totalMs }),
				ticked: (currentMs) => Message.TickedEngine({ seedVersion, currentMs }),
				finished: () => Message.FinishedEngine({ seedVersion }),
				starved: (currentMs) => Message.StarvedEngine({ seedVersion, currentMs }),
			},
		),
})

/** Hands one range to the engine; false while no engine has taken it yet (it is still starting). */
const offerEvents = (element: Element, events: ReadonlyArray<unknown>): boolean =>
	!element.isConnected ||
	!element.dispatchEvent(new CustomEvent(REPLAY_EVENTS, { detail: events, bubbles: true, cancelable: true }))

/**
 * A range loaded after the seed: handed to the live engine beside it, then done. The engine listens
 * only once rrweb has loaded, so the offer repeats until the engine takes it or the span goes away.
 */
export const FeedEvents = Mount.defineStream("FeedReplayEvents", {
	args: { events: Schema.Array(Schema.Unknown) },
	messages: [Message.FedTrailingEvents],
	execute: ({ element, events }) =>
		Stream.fromEffect(
			Effect.sync(() => offerEvents(element, events)).pipe(
				Effect.repeat({ until: (taken) => taken, schedule: Schedule.spaced("50 millis") }),
				Effect.as(Message.FedTrailingEvents()),
			),
		),
})

/** ToggleFullscreen fullscreens the figure, not the studio element the watcher mounts on. */
export const isFigureFullscreen = (fullscreen: Pick<Element, "hasAttribute"> | null): boolean =>
	fullscreen !== null && fullscreen.hasAttribute("data-replay-figure")

/** `useReplayKeyboardShortcuts` and `fullscreenchange`, for the page's lifetime. */
export const WatchPlayerKeys = Mount.defineStream("WatchReplayPlayerKeys", {
	messages: [Message.ClickedPlay, Message.RequestedSeekBy, Message.ChangedFullscreen],
	execute: () =>
		Stream.callback<
			| typeof Message.ClickedPlay.Type
			| typeof Message.RequestedSeekBy.Type
			| typeof Message.ChangedFullscreen.Type
		>((queue) =>
			Effect.acquireRelease(
				Effect.sync(() => {
					const onKey = (event: KeyboardEvent) => {
						if (event.metaKey || event.ctrlKey || event.altKey || isEditableTarget(event.target) || isDialogOpen())
							return
						if (event.code === "Space") {
							event.preventDefault()
							Queue.offerUnsafe(queue, Message.ClickedPlay())
						} else if (event.code === "ArrowLeft" || event.code === "ArrowRight") {
							event.preventDefault()
							Queue.offerUnsafe(
								queue,
								Message.RequestedSeekBy({ deltaMs: event.code === "ArrowLeft" ? -5000 : 5000 }),
							)
						}
					}
					const onFullscreen = () =>
						Queue.offerUnsafe(
							queue,
							Message.ChangedFullscreen({ isFullscreen: isFigureFullscreen(document.fullscreenElement) }),
						)
					window.addEventListener("keydown", onKey)
					document.addEventListener("fullscreenchange", onFullscreen)
					return () => {
						window.removeEventListener("keydown", onKey)
						document.removeEventListener("fullscreenchange", onFullscreen)
					}
				}),
				(stop) => Effect.sync(stop),
			).pipe(Effect.flatMap(() => Effect.never)),
		),
})


/** Where a press landed along a scrub surface (`msFromClientX`), as a 0 to 1 share. */
export const MeasureScrub = Command.define("MeasureReplayScrub", {
	args: { surface: Schema.String, clientX: Schema.Number },
	messages: [Message.MeasuredScrub],
	execute: ({ surface, clientX }) =>
		Effect.sync(() => {
			const rect = document.querySelector(`[data-replay-scrub="${surface}"]`)?.getBoundingClientRect()
			const ratio = rect === undefined || rect.width <= 0 ? 0 : (clientX - rect.left) / rect.width
			return Message.MeasuredScrub({ ratio: Math.max(0, Math.min(1, ratio)) })
		}),
})

/** The figure enters or leaves fullscreen; `fullscreenchange` reports the result. */
export const ToggleFullscreen = Command.define("ToggleReplayFullscreen", {
	messages: [Message.CompletedFullscreenToggle],
	execute: Effect.sync(() => {
		if (document.fullscreenElement !== null) void document.exitFullscreen()
		else void document.querySelector<HTMLElement>("[data-replay-figure]")?.requestFullscreen()
		return Message.CompletedFullscreenToggle()
	}),
})
