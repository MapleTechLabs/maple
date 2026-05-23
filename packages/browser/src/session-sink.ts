// Trace ids observed during the active replay session. Read when the session
// metadata is finalized so the session row links to its traces. Lives outside
// `tracing.ts` because the ids can be contributed by two sources: this SDK's own
// instrumentation (via the BatchSpanProcessor sibling collector) and an external
// tracer — notably the Effect client SDK, which exports through its own pipeline
// and pushes ids in via the published global sink.
const observedTraceIds = new Set<string>()

/** Record a trace id seen during the session. Idempotent per id. */
export function recordTraceId(traceId: string): void {
	observedTraceIds.add(traceId)
}

export function getObservedTraceIds(): string[] {
	return Array.from(observedTraceIds)
}

// Global key external tracers look up to feed trace ids into the session.
// Kept in sync by hand with `lib/effect-sdk/src/client/layer.ts`, which redeclares
// the same literal + shape to avoid depending on `@maple/browser`.
const SESSION_SINK_KEY = "__MAPLE_BROWSER_SESSION__"

interface MapleBrowserSessionSink {
	readonly sessionId: string
	readonly recordTraceId: (traceId: string) => void
}

/**
 * Publish the session sink on `globalThis` so other tracers in the page (e.g. the
 * Effect client SDK) can attach their trace ids to this replay session without a
 * direct dependency on `@maple/browser`. Reads are lazy/per-span on the consumer
 * side, so init ordering between the SDKs does not matter.
 */
export function publishSessionSink(sessionId: string): void {
	const sink: MapleBrowserSessionSink = { sessionId, recordTraceId }
	;(globalThis as Record<string, unknown>)[SESSION_SINK_KEY] = sink
}
