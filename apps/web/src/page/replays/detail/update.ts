import { Option, Result } from "effect"
import { AsyncData, Command } from "foldkit"
import * as Keyed from "../../../data/keyed"
import { requestKey } from "../../../data/request-key"
import * as CopyButton from "../../../ui/copy-button"
import { type PageContext, type PageReturn, pickCommands } from "../../contract"
import { combineRangeMetas, deriveMeta } from "../kit/replay-meta"
import { rangeKey, replayRangeInput } from "../kit/replay-range"
import {
	FetchDetail,
	FetchManifest,
	FetchRange,
	FetchSpans,
	FetchTraceSummaries,
	FetchTranscript,
	MeasureScrub,
	ResolveClock,
	ToggleFullscreen,
} from "./command"
import {
	detailOf,
	manifestTotalMs,
	playerStatus,
	realOffsetOf,
	traceWindowOf,
	windowOf,
} from "./derive"
import {
	advance,
	cacheRange,
	emptyLoader,
	planOnce,
	reportProgress,
	requestSeek,
	retryAt,
	skipFailed,
	subscribedRange,
} from "./loader"
import { Message } from "./message"
import type { Model, Player } from "./model"
import { controlValue, type TransportAction } from "../kit/replay-engine-mount"

type Return = PageReturn<Model, Message>
type Route = { readonly sessionId: string; readonly search: Model["search"] }

const initialPlayer: Player = {
	isPlaying: false,
	isFinished: false,
	currentMs: 0,
	totalMs: 0,
	speed: 1,
	isSkippingIdle: true,
	isFullscreen: false,
	control: "",
	controlNonce: 0,
}

const sessionInput = (model: Model) => ({ sessionId: model.sessionId, ...windowOf(model) })

// REQUESTS

/** The route loader's reads: the session row, the manifest and the transcript. */
const requestEntry = (model: Model, context: PageContext, mode: Keyed.RequestMode): Return => {
	const data = sessionInput(model)
	const slots = [
		["detail", requestKey(context.orgId, "getReplay", { data })],
		["manifest", requestKey(context.orgId, "getReplayManifest", { data })],
		["transcript", requestKey(context.orgId, "getSessionTranscript", { data })],
	] as const
	const detail = Keyed.request(model.detail, slots[0][1], mode)
	const manifest = Keyed.request(model.manifest, slots[1][1], mode)
	const transcript = Keyed.request(model.transcript, slots[2][1], mode)
	return {
		model: {
			...model,
			detail: Option.getOrElse(detail, () => model.detail),
			manifest: Option.getOrElse(manifest, () => model.manifest),
			transcript: Option.getOrElse(transcript, () => model.transcript),
		},
		commands: [
			...(Option.isSome(detail)
				? [FetchDetail({ key: slots[0][1], ...data, refresh: mode === "Refresh" })]
				: []),
			...(Option.isSome(manifest)
				? [FetchManifest({ key: slots[1][1], ...data, refresh: mode === "Refresh" })]
				: []),
			...(Option.isSome(transcript)
				? [FetchTranscript({ key: slots[2][1], ...data, refresh: mode === "Refresh" })]
				: []),
		],
	}
}

/** The studio's own reads once the session is known: the events subscription and the trace bars. */
const requestStudio = (model: Model, context: PageContext): Return => {
	const session = detailOf(model)
	if (session === undefined) return { model }
	const window = traceWindowOf(model, session)
	const summariesKey = requestKey(context.orgId, "getSessionTraceSummaries", {
		data: { traceIds: session.traceIds, ...window },
	})
	const summaries = Keyed.request(model.traceSummaries, summariesKey, "Load")
	// The first subscription is always 0–0, sent before the manifest is known;
	// that request goes out even when the plan already names another range.
	const opening = { fromChunkSeq: 0, toChunkSeq: 0 }
	const isFirstMount = model.loader.range.key === null
	const ranged = syncRange(model, context)
	const prefetch =
		isFirstMount && rangeKey(subscribedRange(model)) !== rangeKey(opening)
			? [
					FetchRange({
						key: rangeRequestKey(model, context, opening),
						sessionId: model.sessionId,
						...opening,
						...windowOf(model),
					}),
				]
			: []
	return {
		model: { ...ranged.model, traceSummaries: Option.getOrElse(summaries, () => model.traceSummaries) },
		commands: [
			...prefetch,
			...(ranged.commands ?? []),
			...(Option.isSome(summaries)
				? [FetchTraceSummaries({ key: summariesKey, traceIds: session.traceIds, ...window })]
				: []),
		],
	}
}

const rangeRequestKey = (
	model: Model,
	context: PageContext,
	range: { fromChunkSeq: number; toChunkSeq: number },
) =>
	requestKey(context.orgId, "getReplayEvents", {
		data: replayRangeInput(model.sessionId, windowOf(model), range),
	})

/** The single events subscription: answer from the cache or fetch, then commit what it can. */
const syncRange = (model: Model, context: PageContext, mode: Keyed.RequestMode = "Load"): Return => {
	const range = subscribedRange(model)
	const key = rangeRequestKey(model, context, range)
	const cached = model.loader.rangeCache[key]
	if (cached !== undefined && mode === "Load") {
		const answered: Model = {
			...model,
			loader: { ...model.loader, range: { key, data: AsyncData.Success({ data: cached }) } },
		}
		const advanced = withMeta(model, advance(answered, Option.some(cached)))
		return rangeKey(subscribedRange(advanced)) === rangeKey(range)
			? { model: advanced }
			: syncRange(advanced, context)
	}
	// A failed range is not asked again on every engine tick; the player's retry button refreshes it.
	const failed = model.loader.range.key === key && AsyncData.isFailure(model.loader.range.data)
	if (failed && mode === "Load") return { model }
	return Option.match(Keyed.request(model.loader.range, key, mode), {
		onNone: () => ({ model }),
		onSome: (slot) => ({
			model: { ...model, loader: { ...model.loader, range: slot } },
			commands: [FetchRange({ key, sessionId: model.sessionId, ...range, ...windowOf(model) })],
		}),
	})
}

/** After a commit: the recording's markers and gaps, from every range loaded so far. */
const withMeta = (before: Model, after: Model): Model => {
	const { originMs, rangeMetas } = after.loader
	if (rangeMetas === before.loader.rangeMetas || originMs === null) return after
	return { ...after, meta: combineRangeMetas(originMs, rangeMetas) }
}

// TRANSPORT

const instruct = (
	model: Model,
	action: TransportAction,
	offsetMs?: number,
	patch: Partial<Player> = {},
): Model => {
	const controlNonce = model.player.controlNonce + 1
	return {
		...model,
		player: {
			...model.player,
			...patch,
			controlNonce,
			control: controlValue(controlNonce, action, offsetMs),
		},
	}
}

const isReady = (model: Model): boolean => {
	const session = detailOf(model)
	return session !== undefined && playerStatus(model, session).status === "ready"
}

/** `togglePlay`. */
const togglePlay = (model: Model): Model => {
	if (!isReady(model)) return model
	const { player } = model
	if (player.isFinished)
		return instruct(model, "replay", undefined, { currentMs: 0, isFinished: false, isPlaying: true })
	if (player.isPlaying) return instruct(model, "pause", undefined, { isPlaying: false })
	return instruct(model, "resume", undefined, { isPlaying: true })
}

/** `applySeek`: rebuild outside the loaded span, else drive the engine. */
const seekTo = (model: Model, context: PageContext, offsetMs: number): Return => {
	if (!isReady(model)) return { model }
	const { player } = model
	const clamped = Math.max(0, Math.min(offsetMs, player.totalMs))
	const placed: Model = {
		...model,
		player: {
			...player,
			currentMs: clamped,
			isFinished: clamped < player.totalMs ? false : player.isFinished,
		},
	}
	return Option.match(requestSeek(placed, clamped, player.isPlaying), {
		onSome: (rebuilt) => syncRange(rebuilt, context),
		onNone: () => ({
			model:
				player.isPlaying && clamped < player.totalMs
					? instruct(placed, "play", clamped)
					: instruct(placed, "pause", clamped),
		}),
	})
}

// ENTRY POINTS

export const init = (route: Route, context: PageContext): Return => {
	const model: Model = {
		sessionId: route.sessionId,
		search: route.search,
		nowMs: 0,
		detail: Keyed.idle(),
		manifest: Keyed.idle(),
		transcript: Keyed.idle(),
		traceSummaries: Keyed.idle(),
		loader: emptyLoader(),
		meta: deriveMeta([]),
		player: initialPlayer,
		railTab: "events",
		eventFilter: "all",
		openEventIndex: null,
		expandedTraces: [],
		spans: {},
		copies: {},
	}
	const entry = requestEntry(model, context, "Load")
	return { model: entry.model, commands: [ResolveClock(), ...(entry.commands ?? [])] }
}

/** The route loader warms the session row, manifest and transcript for the `t` window. */
export const preload = (route: Route, context: PageContext) =>
	pickCommands(init(route, context), [FetchDetail.name, FetchManifest.name, FetchTranscript.name])

/** `t` changes the partition window, and with it every key. */
export const routeChanged = (model: Model, route: Route, context: PageContext): Return =>
	route.search.t === model.search.t
		? { model }
		: requestEntry({ ...model, search: route.search }, context, "Load")

export const contextChanged = (model: Model): Return => ({ model })

const accept = (context: PageContext, next: Model): Return =>
	detailOf(next) === undefined ? { model: next } : requestStudio(next, context)

export const update = (model: Model, message: Message, context: PageContext): Return =>
	Message.match<Return>(message, {
		CompletedResolveClock: ({ nowMs }) => ({ model: { ...model, nowMs } }),
		CompletedFetchDetail: ({ key, result }) =>
			accept(context, { ...model, detail: Keyed.accept(model.detail, key, result) }),
		CompletedFetchManifest: ({ key, result }) => {
			const manifest = Keyed.accept(model.manifest, key, result)
			if (manifest === model.manifest) return { model }
			const next = planOnce({ ...model, manifest })
			const withTotal = {
				...next,
				player: { ...next.player, totalMs: manifestTotalMs(next) || next.player.totalMs },
			}
			return accept(context, withTotal)
		},
		CompletedFetchTranscript: ({ key, result }) => ({
			model: { ...model, transcript: Keyed.accept(model.transcript, key, result) },
		}),
		CompletedFetchTraceSummaries: ({ key, result }) => ({
			model: { ...model, traceSummaries: Keyed.accept(model.traceSummaries, key, result) },
		}),
		CompletedFetchRange: ({ key, result }) => {
			if (key !== model.loader.range.key) return { model }
			const range = Keyed.accept(model.loader.range, key, result)
			const cached = Result.match(result, {
				onSuccess: (rows) => cacheRange(model.loader.rangeCache, key, rows),
				onFailure: () => model.loader.rangeCache,
			})
			const stored: Model = { ...model, loader: { ...model.loader, range, rangeCache: cached } }
			if (Result.isFailure(result))
				// The opening window (or a seek's) failing is the player's error; a background range failing
				// is skipped, and only surfaces if the playhead gets to it.
				return stored.loader.seedCount === 0
					? { model: stored }
					: syncRange(skipFailed(stored, result.failure), context)
			const advanced = advance(stored, Option.some(result.success))
			// A range fetched only for its markers is not kept: past the cap, holding its events is the
			// memory the cap exists to bound.
			const isHeld = advanced.loader.loaded.some(
				(entry) => rangeRequestKey(advanced, context, entry.range) === key,
			)
			const kept = isHeld
				? advanced
				: { ...advanced, loader: { ...advanced.loader, rangeCache: model.loader.rangeCache } }
			return syncRange(withMeta(model, kept), context)
		},
		CompletedFetchSpans: ({ traceId, result }) => ({
			model: {
				...model,
				spans: { ...model.spans, [traceId]: AsyncData.settle(AsyncData.Loading(), result) },
			},
		}),
		ReadiedEngine: ({ seedVersion, totalMs }) => {
			if (seedVersion !== model.loader.seedVersion) return { model }
			const startMs = model.loader.seekTargetMs ?? 0
			const ready: Model = {
				...model,
				loader: { ...model.loader, resumeOnReady: false },
				player: {
					...model.player,
					// rrweb only knows the loaded seed; the manifest knows the whole recording.
					totalMs: manifestTotalMs(model) || totalMs,
					currentMs: startMs,
					isFinished: false,
					isPlaying: false,
				},
			}
			// A seek or window slide that interrupted playback carries on in the new engine.
			return {
				model: model.loader.resumeOnReady
					? instruct(ready, "play", startMs, { isPlaying: true })
					: ready,
			}
		},
		TickedEngine: ({ seedVersion, currentMs }) =>
			seedVersion !== model.loader.seedVersion
				? { model }
				: syncRange(
						reportProgress({ ...model, player: { ...model.player, currentMs } }, currentMs),
						context,
					),
		StarvedEngine: ({ seedVersion, currentMs }) =>
			seedVersion !== model.loader.seedVersion
				? { model }
				: syncRange(
						reportProgress({ ...model, player: { ...model.player, currentMs } }, currentMs, true),
						context,
					),
		FinishedEngine: ({ seedVersion }) =>
			seedVersion !== model.loader.seedVersion
				? { model }
				: { model: { ...model, player: { ...model.player, isPlaying: false, isFinished: true } } },
		ClickedPlay: () => ({ model: togglePlay(model) }),
		PressedScrubber: ({ surface, clientX }) => ({
			model,
			commands: [MeasureScrub({ surface, clientX })],
		}),
		MeasuredScrub: ({ ratio }) => seekTo(model, context, ratio * model.player.totalMs),
		RequestedSeek: ({ offsetMs }) => seekTo(model, context, offsetMs),
		RequestedSeekBy: ({ deltaMs }) => seekTo(model, context, model.player.currentMs + deltaMs),
		RequestedSeekToTimestamp: ({ timestamp }) => {
			const offset = realOffsetOf(model, timestamp)
			return offset === undefined
				? { model }
				: seekTo(model, context, offset)
		},
		PickedSpeed: ({ speed }) => ({ model: { ...model, player: { ...model.player, speed } } }),
		ToggledSkipIdle: () => ({
			model: { ...model, player: { ...model.player, isSkippingIdle: !model.player.isSkippingIdle } },
		}),
		ClickedFullscreen: () => ({ model, commands: [ToggleFullscreen()] }),
		ChangedFullscreen: ({ isFullscreen }) => ({
			model: { ...model, player: { ...model.player, isFullscreen } },
		}),
		CompletedFullscreenToggle: () => ({ model }),
		FedTrailingEvents: () => ({ model }),
		ClickedRetryPlayer: () => {
			if (model.loader.backgroundFailure !== null)
				return syncRange(retryAt(model, model.player.currentMs), context, "Refresh")
			const entry = requestEntry(model, context, "Refresh")
			const ranged = syncRange(entry.model, context, "Refresh")
			return { model: ranged.model, commands: [...(entry.commands ?? []), ...(ranged.commands ?? [])] }
		},
		ClickedRetryDetail: () => requestEntry(model, context, "Refresh"),
		PickedRailTab: ({ tab }) => ({ model: { ...model, railTab: tab } }),
		PickedEventFilter: ({ filter }) => ({
			model: { ...model, eventFilter: filter, openEventIndex: null },
		}),
		ClickedEvent: ({ index, timestamp }) => {
			const toggled = { ...model, openEventIndex: model.openEventIndex === index ? null : index }
			const offset = realOffsetOf(toggled, timestamp)
			return offset === undefined
				? { model: toggled }
				: seekTo(toggled, context, offset)
		},
		ToggledTraceSpans: ({ traceId, startTime }) => {
			const isOpen = model.expandedTraces.includes(traceId)
			const expandedTraces = isOpen
				? model.expandedTraces.filter((id) => id !== traceId)
				: [...model.expandedTraces, traceId]
			// Opening the lane asks again after a failure.
			const cached = model.spans[traceId]
			const needsSpans = !isOpen && (cached === undefined || AsyncData.isFailure(cached))
			return {
				model: {
					...model,
					expandedTraces,
					spans: needsSpans ? { ...model.spans, [traceId]: AsyncData.Loading() } : model.spans,
				},
				commands: needsSpans ? [FetchSpans({ traceId, timestamp: startTime })] : [],
			}
		},
		GotCopyMessage: ({ key, message: inner }) => {
			const next = CopyButton.update(model.copies[key] ?? CopyButton.init(), inner)
			return {
				model: { ...model, copies: { ...model.copies, [key]: next.model } },
				commands: Command.mapMessages(next.commands ?? [], (m) =>
					Message.GotCopyMessage({ key, message: m }),
				),
			}
		},
	})
