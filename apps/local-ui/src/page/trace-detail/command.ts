import type { CacheValue } from "../../data/cache-store"
import { LocalLog, logKey } from "../kit/log-sheet/model"
import { SpanAttrs, type SpanLog } from "./panel-model"
import { SpanDetailRequest, SpanLogsRequest } from "./requests"
import { readCached, recordCached, cachedAs, withCache } from "../../data/cached"
import { traceCacheKey, traceFromCached, traceToCached } from "./cache"
import { Clock, Duration, Effect, Layer, Option, Queue, Schema, Stream } from "effect"
import { TraceDetailDefinition } from "./definition"
import { fetchSpanDetail, fetchSpanLogs, fetchTrace } from "./fetch"
import { Message } from "./message"

export const FetchTrace = TraceDetailDefinition.makeCommand("FetchLocalTraceDetail", {
	args: { key: Schema.String, traceId: Schema.String, apiBase: Schema.String, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchTrace, Message.FailedFetchTrace, Message.FoundCachedTrace],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ key, traceId, apiBase, readsCache }) =>
			Effect.gen(function* () {
				const cacheKey = traceCacheKey(traceId)
				const maybeCached = readsCache
					? yield* readCached(cacheKey, traceFromCached(traceId))
					: Option.none()
				if (Option.isSome(maybeCached))
					return Message.FoundCachedTrace({ key, cached: maybeCached.value })
				const trace = yield* fetchTrace(traceId, apiBase)
				const fetchedAtMs = yield* Clock.currentTimeMillis
				yield* recordCached(cacheKey, traceToCached(trace), fetchedAtMs)
				return Message.SucceededFetchTrace({ key, trace, fetchedAtMs })
			}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTrace({ key, failure }))))
	},
})

export const FetchSpanDetail = TraceDetailDefinition.makeCommand("FetchLocalSpanDetail", {
	args: { ...SpanDetailRequest.fields, readsCache: Schema.Boolean },
	messages: [
		Message.SucceededFetchSpanDetail,
		Message.FailedFetchSpanDetail,
		Message.FoundCachedSpanDetail,
	],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ readsCache, ...request }) =>
			withCache({
				key: ["local", "span-detail", request.traceId, request.spanId],
				readsCache,
				fromCached: cachedAs(SpanAttrs),
				toCached: (detail: SpanAttrs) => detail,
				fetch: fetchSpanDetail(request.traceId, request.spanId, request.apiBase),
				found: (cached) => Message.FoundCachedSpanDetail({ request, cached }),
				succeeded: (detail, fetchedAtMs) =>
					Message.SucceededFetchSpanDetail({ key: request.key, detail, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) =>
					Effect.succeed(Message.FailedFetchSpanDetail({ key: request.key, failure })),
				),
			)
	},
})

/** Legacy caches the rows as `LocalLog`s; the panel keeps each with its `logKey`. */
const spanLogsFromCached = (value: CacheValue): Option.Option<ReadonlyArray<SpanLog>> =>
	Option.map(cachedAs(Schema.Array(LocalLog))(value), (logs) =>
		logs.map((log) => ({ ...log, key: logKey(log) })),
	)

export const FetchSpanLogs = TraceDetailDefinition.makeCommand("FetchLocalSpanLogs", {
	args: { ...SpanLogsRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSpanLogs, Message.FailedFetchSpanLogs, Message.FoundCachedSpanLogs],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	handler: function* () {
		return ({ readsCache, ...request }) =>
			withCache({
				key: [
					"local",
					"span-logs",
					request.traceId,
					request.spanId,
					request.spanStartTime,
					request.spanDurationMs,
				],
				readsCache,
				fromCached: spanLogsFromCached,
				toCached: (logs: ReadonlyArray<SpanLog>) => logs.map(({ key: _key, ...log }) => log),
				fetch: Effect.map(
					fetchSpanLogs(
						request.traceId,
						request.spanId,
						request.spanStartTime,
						request.spanDurationMs,
						request.apiBase,
					),
					(logs): ReadonlyArray<SpanLog> => logs,
				),
				found: (cached) => Message.FoundCachedSpanLogs({ request, cached }),
				succeeded: (logs, fetchedAtMs) =>
					Message.SucceededFetchSpanLogs({ key: request.key, logs, fetchedAtMs }),
			}).pipe(
				Effect.catch((failure) =>
					Effect.succeed(Message.FailedFetchSpanLogs({ key: request.key, failure })),
				),
			)
	},
})

/** `useCopy`: the clipboard write behind every copy control of the span panel. */
export const WriteClipboard = TraceDetailDefinition.makeCommand("WriteLocalSpanClipboard", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedWriteClipboard],
	handler: function* () {
		return ({ id, text, generation }) =>
			Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
				Effect.as(true),
				Effect.orElseSucceed(() => false),
				Effect.map((isOk) => Message.CompletedWriteClipboard({ id, generation, isOk })),
			)
	},
})

/**
 * A deep-linked panel opens with nothing focused, so the page's Escape handler would never hear
 * the key: take focus then. A click keeps focus where it was (the timeline's keyboard navigation).
 */
export const FocusSpanPanel = TraceDetailDefinition.makeMount("FocusLocalSpanPanel", {
	messages: [Message.CompletedFocusSpanPanel],
	handler: function* () {
		return ({ element }) =>
			Effect.sync(() => {
				if (
					element instanceof HTMLElement &&
					(document.activeElement === null || document.activeElement === document.body)
				)
					element.focus({ preventScroll: true })
				return Message.CompletedFocusSpanPanel()
			})
	},
})

/**
 * The pointer's viewport position over the page, at most once per frame (the timeline's
 * `onMouseMove` writes the tooltip position from a rAF).
 */
export const TrackPointer = TraceDetailDefinition.makeMountStream("TrackLocalTracePointer", {
	messages: [Message.MovedPointer],
	handler: function* () {
		return ({ element }) =>
			Stream.callback<typeof Message.MovedPointer.Type>((queue) =>
				Effect.acquireRelease(
					Effect.sync(() => {
						const state = { frame: 0 }
						const onMove = (event: Event) => {
							if (!(event instanceof MouseEvent)) return
							cancelAnimationFrame(state.frame)
							const { clientX, clientY } = event
							state.frame = requestAnimationFrame(() =>
								Queue.offerUnsafe(queue, Message.MovedPointer({ x: clientX, y: clientY })),
							)
						}
						element.addEventListener("mousemove", onMove)
						return () => {
							cancelAnimationFrame(state.frame)
							element.removeEventListener("mousemove", onMove)
						}
					}),
					(cleanup) => Effect.sync(cleanup),
				).pipe(Effect.flatMap(() => Effect.never)),
			)
	},
})

/** The copied or failed state reverts to idle after this long. */
const COPY_TIMEOUT = Duration.millis(2000)

export const WaitCopyStatus = TraceDetailDefinition.makeCommand("WaitLocalSpanCopyStatus", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	handler: function* () {
		return ({ id, generation }) =>
			Effect.as(Effect.sleep(COPY_TIMEOUT), Message.ElapsedCopyStatus({ id, generation }))
	},
})

/** A tab press, brought back as a page Message so the update can read the hash it navigates from. */
export const RelayTabChoice = TraceDetailDefinition.makeCommand("RelayTraceTabChoice", {
	args: { value: Schema.String },
	messages: [Message.ChoseTab],
	handler: function* () {
		return ({ value }) => Effect.succeed(Message.ChoseTab({ value }))
	},
})

/** A timeline or waterfall row press, brought back the same way (the hash owns the selection). */
export const RelaySpanChoice = TraceDetailDefinition.makeCommand("RelayTraceSpanChoice", {
	args: { spanId: Schema.String },
	messages: [Message.ChoseSpan],
	handler: function* () {
		return ({ spanId }) => Effect.succeed(Message.ChoseSpan({ spanId }))
	},
})

export type TraceDetailCommand =
	| ReturnType<typeof FetchTrace>
	| ReturnType<typeof FetchSpanDetail>
	| ReturnType<typeof FetchSpanLogs>
	| ReturnType<typeof WriteClipboard>
	| ReturnType<typeof WaitCopyStatus>
	| ReturnType<typeof RelayTabChoice>
	| ReturnType<typeof RelaySpanChoice>

export const CommandsLayer = Layer.mergeAll(
	FetchTrace.layer,
	FetchSpanDetail.layer,
	FetchSpanLogs.layer,
	WriteClipboard.layer,
	WaitCopyStatus.layer,
	RelayTabChoice.layer,
	RelaySpanChoice.layer,
	FocusSpanPanel.layer,
	TrackPointer.layer,
)
