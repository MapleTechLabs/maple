// `@maple-dev/browser/server`: the server half of frontend tracing.
//
// Server-side data loading (Server Components, SSR loaders and resolvers) runs
// in spans from the global tracer, so it nests under whatever OpenTelemetry
// setup the server registered, and the rendered page tells the browser which
// trace to join. Depends on `@opentelemetry/api` only: safe in Node, edge
// runtimes and Workers. Without server OpenTelemetry, both do nothing.
import { trace } from "@opentelemetry/api"
import { runTraced, type TracedOptions } from "./failures"
import { activeTraceparent, serverTimingEntry } from "./traceparent"
import { SDK_NAME, SDK_VERSION } from "./version"

export type { TracedOptions } from "./failures"

/**
 * Run server-side data loading in a span under the active one. Errors are recorded once and rethrown.
 * Without server OpenTelemetry it only runs `fn`.
 */
export function traced<T>(name: string, fn: () => Promise<T>, options: TracedOptions = {}): Promise<T> {
	// Per call, not cached: the app may register its provider after this module loads
	return trace
		.getTracer(SDK_NAME, SDK_VERSION)
		.startActiveSpan(name, (span) => runTraced(span, fn, options))
}

/**
 * The `Server-Timing` header value that joins the browser's page load to the active server trace,
 * or `undefined` when no span is active: `headers.append("server-timing", value)`.
 */
export function serverTiming(): string | undefined {
	const traceparent = activeTraceparent()
	return traceparent && serverTimingEntry(traceparent)
}
