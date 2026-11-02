import { SpanId, TraceId } from "@maple/domain"
import { type LocalLog, logKey } from "../../lib/log-shape"
import { cachedSpanLogRecords, fetchSpanLogRecords } from "../../data/trace-source"
import { readCached, recordCached } from "../../data/cached"
import { traceCacheKey, traceFromCached, traceToCached } from "../../data/trace-cache"
import { Clock, Effect, Option, Queue, Schema, Stream } from "effect"
import { Command, Mount } from "foldkit"
import { fetchTrace } from "../../data/trace-fetch"
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

/**
 * A Logs-tab row was clicked: its whole log, from the cache the panel's read filled, else read
 * again. A log the source no longer has (or a failed read) reports back so the page refreshes.
 */
export const ReadSpanLog = Command.define("ReadLocalSpanLog", {
	args: {
		traceId: TraceId,
		spanId: SpanId,
		startTime: Schema.String,
		durationMs: Schema.Number,
		limit: Schema.Number,
		key: Schema.String,
		apiBase: Schema.String,
	},
	messages: [Message.FoundSpanLog, Message.FailedReadSpanLog],
	execute: ({ key, apiBase, ...request }) =>
		Effect.gen(function* () {
			const find = (logs: ReadonlyArray<LocalLog>) => Option.fromNullishOr(logs.find((log) => logKey(log) === key))
			const cached = Option.flatMap(yield* cachedSpanLogRecords(request), (hit) => find(hit.data))
			const log = Option.isSome(cached) ? cached : find(yield* fetchSpanLogRecords(request, apiBase))
			return Option.match(log, { onNone: () => Message.FailedReadSpanLog(), onSome: (found) => Message.FoundSpanLog({ log: found }) })
		}).pipe(Effect.orElseSucceed(() => Message.FailedReadSpanLog())),
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
