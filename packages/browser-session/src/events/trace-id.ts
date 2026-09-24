// The active-trace-id lookup lives in its own module rather than in
// `events-sink`, because the capture modules need it and the sink imports the
// capture modules — routing it through the sink would make that a cycle.

const ZERO_TRACE_ID = "00000000000000000000000000000000"

// Injected by the host SDK (e.g. `@maple-dev/browser` wires OTel's
// `trace.getActiveSpan()`), keeping this engine free of tracing dependencies.
// Without a provider, events simply carry no trace id.
let traceIdProvider: () => string | undefined = () => undefined

/** Wire the host SDK's active-trace-id lookup into event capture. */
export function setActiveTraceIdProvider(provider: () => string | undefined): void {
	traceIdProvider = provider
}

/** The trace id of the active span, or undefined when none is active. */
export function activeTraceId(): string | undefined {
	const id = traceIdProvider()
	return id && id !== ZERO_TRACE_ID ? id : undefined
}

// A fetch/XHR wrapper sits *outside* any tracing instrumentation installed
// before it, so the span the request creates does not exist yet when the
// wrapper reads `activeTraceId()`: a request fired from a click handler read no
// id at all. Instead the wrapper opens a slot around the synchronous call into
// the next fetch, and the first span started inside it (reported through
// `recordTraceId`) fills the slot.
/** One open capture window: the first span started inside it, if any. */
interface TraceSlot {
	traceId: string | undefined
}

const slots: Array<TraceSlot> = []

/** Report a span that just started. Fills the innermost open slot, first span wins. */
export function noteStartedTraceId(traceId: string): void {
	const slot = slots.at(-1)
	if (slot && slot.traceId === undefined && traceId !== ZERO_TRACE_ID) slot.traceId = traceId
}

/** Run `fn`, returning its result and the trace id of the first span started during it. */
export function withStartedTraceId<T>(fn: () => T): {
	readonly result: T
	readonly traceId: string | undefined
} {
	const slot: TraceSlot = { traceId: undefined }
	slots.push(slot)
	try {
		return { result: fn(), traceId: slot.traceId }
	} finally {
		const index = slots.lastIndexOf(slot)
		if (index !== -1) slots.splice(index, 1)
	}
}
