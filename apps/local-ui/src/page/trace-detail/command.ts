import type { CacheValue } from "../../data/cache-store"
import { LocalLog, logKey } from "../kit/log-sheet/model"
import { SpanAttrs, type SpanLog } from "./panel-model"
import { SpanDetailRequest, SpanLogsRequest } from "./requests"
import { readCached, recordCached, cachedAs, withCache } from "../../data/cached"
import { traceCacheKey, traceFromCached, traceToCached } from "./cache"
import { Clock, Duration, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { fetchSpanDetail, fetchSpanLogs, fetchTrace } from "./fetch"
import { Message } from "./message"

export const FetchTrace = Command.define("FetchLocalTraceDetail", {
	args: { key: Schema.String, traceId: Schema.String, apiBase: Schema.String, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchTrace, Message.FailedFetchTrace, Message.FoundCachedTrace],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ key, traceId, apiBase, readsCache }) =>
		Effect.gen(function* () {
			const cacheKey = traceCacheKey(traceId)
			const maybeCached = readsCache ? yield* readCached(cacheKey, traceFromCached(traceId)) : Option.none()
			if (Option.isSome(maybeCached)) return Message.FoundCachedTrace({ key, cached: maybeCached.value })
			const trace = yield* fetchTrace(traceId, apiBase)
			const fetchedAtMs = yield* Clock.currentTimeMillis
			yield* recordCached(cacheKey, traceToCached(trace), fetchedAtMs)
			return Message.SucceededFetchTrace({ key, trace, fetchedAtMs })
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchTrace({ key, failure })))),
})

export const FetchSpanDetail = Command.define("FetchLocalSpanDetail", {
	args: { ...SpanDetailRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSpanDetail, Message.FailedFetchSpanDetail, Message.FoundCachedSpanDetail],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "span-detail", request.traceId, request.spanId],
			readsCache,
			fromCached: cachedAs(SpanAttrs),
			toCached: (detail: SpanAttrs) => detail,
			fetch: fetchSpanDetail(request.traceId, request.spanId, request.apiBase),
			found: (cached) => Message.FoundCachedSpanDetail({ request, cached }),
			succeeded: (detail, fetchedAtMs) => Message.SucceededFetchSpanDetail({ key: request.key, detail, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSpanDetail({ key: request.key, failure })))),
})

/** Legacy caches the rows as `LocalLog`s; the panel keeps each with its `logKey`. */
const spanLogsFromCached = (value: CacheValue): Option.Option<ReadonlyArray<SpanLog>> =>
	Option.map(cachedAs(Schema.Array(LocalLog))(value), (logs) => logs.map((log) => ({ ...log, key: logKey(log) })))

export const FetchSpanLogs = Command.define("FetchLocalSpanLogs", {
	args: { ...SpanLogsRequest.fields, readsCache: Schema.Boolean },
	messages: [Message.SucceededFetchSpanLogs, Message.FailedFetchSpanLogs, Message.FoundCachedSpanLogs],
	interrupt: { keyFields: ["key"], toKey: ({ key }) => key },
	execute: ({ readsCache, ...request }) =>
		withCache({
			key: ["local", "span-logs", request.traceId, request.spanId, request.spanStartTime, request.spanDurationMs],
			readsCache,
			fromCached: spanLogsFromCached,
			toCached: (logs: ReadonlyArray<SpanLog>) => logs.map(({ key: _key, ...log }) => log),
			fetch: Effect.map(
				fetchSpanLogs(request.traceId, request.spanId, request.spanStartTime, request.spanDurationMs, request.apiBase),
				(logs): ReadonlyArray<SpanLog> => logs,
			),
			found: (cached) => Message.FoundCachedSpanLogs({ request, cached }),
			succeeded: (logs, fetchedAtMs) => Message.SucceededFetchSpanLogs({ key: request.key, logs, fetchedAtMs }),
		}).pipe(Effect.catch((failure) => Effect.succeed(Message.FailedFetchSpanLogs({ key: request.key, failure })))),
})

/** `useCopy`: the clipboard write behind every copy control of the span panel. */
export const WriteClipboard = Command.define("WriteLocalSpanClipboard", {
	args: { id: Schema.String, text: Schema.String, generation: Schema.Number },
	messages: [Message.CompletedWriteClipboard],
	execute: ({ id, text, generation }) =>
		Effect.tryPromise(() => navigator.clipboard.writeText(text)).pipe(
			Effect.as(true),
			Effect.orElseSucceed(() => false),
			Effect.map((isOk) => Message.CompletedWriteClipboard({ id, generation, isOk })),
		),
})

/**
 * A deep-linked panel opens with nothing focused, so the page's Escape handler would never hear
 * the key: take focus then. A click keeps focus where it was (the timeline's keyboard navigation).
 */
export const FocusSpanPanel = Mount.define("FocusLocalSpanPanel", {
	messages: [Message.CompletedFocusSpanPanel],
	execute: ({ element }) =>
		Effect.sync(() => {
			if (element instanceof HTMLElement && (document.activeElement === null || document.activeElement === document.body))
				element.focus({ preventScroll: true })
			return Message.CompletedFocusSpanPanel()
		}),
})

/**
 * The pointer's viewport position over the page, at most once per frame (the timeline's
 * `onMouseMove` writes the tooltip position from a rAF).
 */
export const TrackPointer = Mount.defineStream("TrackLocalTracePointer", {
	messages: [Message.MovedPointer],
	execute: ({ element }) =>
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
		),
})

/** The copied or failed state reverts to idle after this long. */
const COPY_TIMEOUT = Duration.millis(2000)

export const WaitCopyStatus = Command.define("WaitLocalSpanCopyStatus", {
	args: { id: Schema.String, generation: Schema.Number },
	messages: [Message.ElapsedCopyStatus],
	execute: ({ id, generation }) => Effect.as(Effect.sleep(COPY_TIMEOUT), Message.ElapsedCopyStatus({ id, generation })),
})
