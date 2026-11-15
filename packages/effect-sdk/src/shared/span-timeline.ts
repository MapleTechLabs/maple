// Which span was on the CPU, and when. A sampling profiler only knows the call stack at each
// tick; this is the other half that lets a sample be attributed to a span.
//
// JavaScript runs one thing at a time, and Effect asks the tracer before it evaluates each step of
// a fiber. So noting the fiber's span whenever it differs from the last one seen yields an exact,
// ordered record of span switches, with no native addon and no async hooks.
//
// Limitation: only Effect evaluation is observed, so CPU time in a promise continuation (the code
// after an `await` inside `Effect.promise`) is not attributed to the enclosing span.
import type { Fiber, Tracer } from "effect"

const EVALUATE = "~effect/Effect/evaluate"

/** A span as a profile link needs it. */
export interface TimelineSpan {
	readonly traceId: string
	readonly spanId: string
}

/** Span switches in time order: from `times[i]` on, `spans[i]` was running (`undefined`: none). */
export interface SpanEvents {
	/** `performance.now()` milliseconds. */
	readonly times: Float64Array
	readonly spans: ReadonlyArray<TimelineSpan | undefined>
	readonly length: number
	/** The log filled up: nothing after `times[length - 1]` can be attributed. */
	readonly overflowed: boolean
}

export interface SpanTimeline {
	/** The tracer, with the hook that records which span each evaluated step ran under. */
	readonly instrument: (tracer: Tracer.Tracer) => Tracer.Tracer
	/** Recording costs a clock read per span switch; off, the hook only compares two references. */
	readonly setRecording: (recording: boolean) => void
	/** The events since the last drain. The span still running opens the next batch. */
	readonly drain: () => SpanEvents
}

/** Span switches one profile window can hold. Past it the window's later samples go unlinked. */
export const SPAN_EVENT_CAPACITY = 1 << 17

export const makeSpanTimeline = (
	options: { readonly capacity?: number; readonly now?: () => number } = {},
): SpanTimeline => {
	const capacity = options.capacity ?? SPAN_EVENT_CAPACITY
	const now = options.now ?? (() => performance.now())
	let times = new Float64Array(capacity)
	let spans: Array<TimelineSpan | undefined> = []
	let length = 0
	let overflowed = false
	let recording = false
	let current: Tracer.AnySpan | undefined
	let closing = false

	const push = (span: Tracer.AnySpan | undefined): void => {
		if (length >= capacity) {
			overflowed = true
			return
		}
		times[length] = now()
		// Only this process's own sampled spans: a remote parent did not run here, and a link to
		// a span that is never exported leads nowhere.
		spans[length] =
			span?._tag === "Span" && span.sampled ? { traceId: span.traceId, spanId: span.spanId } : undefined
		length += 1
	}

	// Runs once the call stack unwinds, which is when the fibers of this turn have stopped: from
	// here until the next evaluated step, no span is on the CPU.
	const close = (): void => {
		closing = false
		if (current !== undefined) {
			current = undefined
			if (recording) push(undefined)
		}
	}

	const note = (span: Tracer.AnySpan | undefined): void => {
		current = span
		if (recording) push(span)
		if (!closing) {
			closing = true
			queueMicrotask(close)
		}
	}

	return {
		instrument: (tracer) => ({
			span: (spanOptions) => tracer.span(spanOptions),
			context<X>(primitive: Tracer.EffectPrimitive<X>, fiber: Fiber.Fiber<unknown, unknown>): X {
				const span = fiber.cache.span
				if (span !== current) note(span)
				return primitive[EVALUATE](fiber)
			},
		}),
		setRecording: (next) => {
			// The span already on the CPU opens the log, as it does across a drain.
			if (next && !recording && current !== undefined) push(current)
			recording = next
		},
		drain: () => {
			const drained: SpanEvents = { times, spans, length, overflowed }
			times = new Float64Array(capacity)
			spans = []
			length = 0
			overflowed = false
			// The span running across the boundary is the first thing the next window knows.
			if (recording && current !== undefined) push(current)
			return drained
		},
	}
}

/** The span running at `timeMs`, by binary search over the switches. */
export const spanAt = (events: SpanEvents, timeMs: number): TimelineSpan | undefined => {
	if (events.length === 0 || timeMs < (events.times[0] ?? Number.POSITIVE_INFINITY)) return undefined
	const last = events.length - 1
	if (events.overflowed && timeMs > (events.times[last] ?? 0)) return undefined
	let low = 0
	let high = last
	while (low < high) {
		const middle = (low + high + 1) >>> 1
		if ((events.times[middle] ?? Number.POSITIVE_INFINITY) <= timeMs) low = middle
		else high = middle - 1
	}
	return events.spans[low]
}
