import { Duration, Effect, Option, Array as Arr, String as Str } from "effect"

/**
 * The browser's own timing of one API request, on the span around it.
 *
 * A fetch span ends when JS sees the response headers, which a busy main thread delays, so it
 * cannot tell network time from waiting. The Resource Timing entry can. The observer keeps
 * recent entries past the timeline's 250-entry buffer, which a long-lived dashboard tab fills.
 */
/** The fields read here, so tests can build entries without a browser. */
export type ResourceTimingEntry = Pick<
	PerformanceResourceTiming,
	"name" | "startTime" | "requestStart" | "responseStart" | "responseEnd" | "nextHopProtocol"
>

const RECENT_MAX = 200
const recent: Array<ResourceTimingEntry> = []
const claimed = new WeakSet<ResourceTimingEntry>()
let observing = false

const isResourceTiming = (entry: PerformanceEntry): entry is PerformanceResourceTiming =>
	entry.entryType === "resource"

const observe = (): void => {
	if (observing || typeof PerformanceObserver === "undefined") return
	if (!PerformanceObserver.supportedEntryTypes.includes("resource")) return
	observing = true
	new PerformanceObserver((list) => {
		Arr.forEach(list.getEntries(), (entry) => {
			if (isResourceTiming(entry) && entry.initiatorType === "fetch") recent.push(entry)
		})
		if (recent.length > RECENT_MAX) recent.splice(0, recent.length - RECENT_MAX)
	}).observe({ type: "resource", buffered: false })
}

const pathOf = (url: string): string => {
	const parsed = URL.canParse(url) ? new URL(url) : undefined
	return parsed?.pathname ?? url
}

/** The earliest unclaimed fetch to `path` that started and finished inside `[startedAt, doneAt]`. */
export const findResourceTiming = (
	entries: ReadonlyArray<ResourceTimingEntry>,
	path: string,
	startedAt: number,
	doneAt: number,
): ResourceTimingEntry | undefined =>
	Option.getOrUndefined(
		Arr.findFirst(
			entries,
			(entry) =>
				!claimed.has(entry) &&
				Str.endsWith(path)(pathOf(entry.name)) &&
				entry.startTime >= startedAt &&
				entry.responseEnd <= doneAt,
		),
	)

const round = (ms: number): number => Math.round(ms * 10) / 10

/** The span attributes for one entry; `doneAt` is when the caller had the decoded result. */
export const resourceTimingAttributes = (
	entry: ResourceTimingEntry,
	startedAt: number,
	doneAt: number,
): Record<string, number | string> => ({
	// Before the browser issued the request: request mapping, the session token.
	"maple.http.timing.start_delay_ms": round(entry.startTime - startedAt),
	// Queued for a connection, or connecting.
	"maple.http.timing.stalled_ms": round(entry.requestStart - entry.startTime),
	// Request sent to first response byte: network both ways plus the server.
	"maple.http.timing.ttfb_ms": round(entry.responseStart - entry.requestStart),
	"maple.http.timing.download_ms": round(entry.responseEnd - entry.responseStart),
	// Bytes in hand until the caller resumed: main-thread wait plus decoding.
	"maple.http.timing.after_response_ms": round(doneAt - entry.responseEnd),
	"maple.http.timing.protocol": entry.nextHopProtocol,
})

const lookup = (path: string, startedAt: number, doneAt: number): ResourceTimingEntry | undefined =>
	findResourceTiming(
		Arr.filter(performance.getEntriesByType("resource"), isResourceTiming),
		path,
		startedAt,
		doneAt,
	) ?? findResourceTiming(recent, path, startedAt, doneAt)

const annotate = (entry: ResourceTimingEntry | undefined, startedAt: number, doneAt: number) => {
	if (entry === undefined) return Effect.annotateCurrentSpan("maple.http.timing.missing", true)
	claimed.add(entry)
	return Effect.annotateCurrentSpan(resourceTimingAttributes(entry, startedAt, doneAt))
}

/** Annotates the current span with the Resource Timing of the one request `effect` makes to `path`. */
export const withResourceTiming =
	(path: string) =>
	<A, E, R>(effect: Effect.Effect<A, E, R>): Effect.Effect<A, E, R> =>
		Effect.suspend(() => {
			observe()
			const startedAt = performance.now()
			return Effect.onExit(effect, () =>
				Effect.suspend(() => {
					const doneAt = performance.now()
					const entry = lookup(path, startedAt, doneAt)
					if (entry !== undefined) return annotate(entry, startedAt, doneAt)
					// With the timeline buffer full only the observer has it, and it delivers a task later.
					// @effect-diagnostics-next-line effectSleepZeroToYieldNow:off -- needs a macrotask for the observer to deliver; yieldNow does not wait one
					return Effect.sleep(Duration.zero).pipe(
						Effect.andThen(
							Effect.suspend(() =>
								annotate(lookup(path, startedAt, doneAt), startedAt, doneAt),
							),
						),
					)
				}),
			)
		})
