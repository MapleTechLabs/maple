import { Effect, Layer, Tracer } from "effect"

/**
 * Key the `@maple-dev/browser` SDK publishes its replay session sink under. Looked up
 * lazily per span so init ordering between the SDKs does not matter; absent on
 * non-replay pages and during SSR, where the decorator below no-ops.
 */
const SESSION_SINK_KEY = "__MAPLE_BROWSER_SESSION__"

interface SessionSink {
	readonly sessionId: string
	readonly recordTraceId: (traceId: string) => void
}

/**
 * Decorate the OTLP tracer so every span it creates reports its trace id to the
 * active browser replay session (when one exists) and carries `session.id`. This
 * is what links a replay session to the Effect HTTP traces it produced — instead
 * of the redundant auto-instrumented fetch spans `@maple-dev/browser` would otherwise
 * collect. `provideMerge` keeps the base layer's logger/metrics while overriding
 * only the Tracer reference. No-ops cleanly when no session sink is published.
 *
 * Shared by the `Otlp.layerJson`-based client `layer` and the buffer-backed
 * client `MapleFlush.make` preset so both link replay sessions identically.
 */
export const withSessionLink = <ROut, E, RIn>(base: Layer.Layer<ROut, E, RIn>) =>
	Layer.effect(
		Tracer.Tracer,
		Effect.map(
			Effect.tracer,
			(inner): Tracer.Tracer =>
				Tracer.make({
					context: inner.context,
					span(options) {
						const span = inner.span(options)
						const sink = (globalThis as Record<string, unknown>)[SESSION_SINK_KEY] as
							| SessionSink
							| undefined
						if (sink) {
							sink.recordTraceId(span.traceId)
							span.attribute("session.id", sink.sessionId)
						}
						return span
					},
				}),
		),
	).pipe(Layer.provideMerge(base))
