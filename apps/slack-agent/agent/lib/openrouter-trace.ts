import { isSpanContextValid, trace } from "@opentelemetry/api"

/**
 * The `fetch` the OpenRouter provider sends its requests through: it stamps the calling span's
 * W3C ids onto the request as `trace.trace_id` / `trace.parent_span_id`.
 *
 * OpenRouter's Broadcast export uses them verbatim, so the `LLM Generation` trace it sends Maple
 * for every call (provider attempts, fallbacks, router latency) nests under the AI SDK span that
 * made the call. Without them each call arrived as a root trace of its own — the session still
 * held them, through `session_id`, but as one detached trace per model call. The provider's
 * `extraBody` cannot carry the ids: it is fixed when the model is built, and the ids are per call.
 *
 * `globalThis.fetch` is read per call, not captured: the tests stub it, and undici's
 * instrumentation patches it after this module loads.
 */
// SAFETY: Bun's `typeof fetch` also declares `preconnect`, a warm-up hint the provider never calls;
// the call signature is the whole contract here.
export const openRouterFetch = ((input: RequestInfo | URL, init?: RequestInit) => {
	const spanContext = trace.getActiveSpan()?.spanContext()
	if (spanContext === undefined || !isSpanContextValid(spanContext) || typeof init?.body !== "string") {
		return globalThis.fetch(input, init)
	}
	return globalThis.fetch(input, { ...init, body: withTraceIds(init.body, spanContext) })
}) as typeof fetch

const withTraceIds = (body: string, span: { traceId: string; spanId: string }): string => {
	try {
		// SAFETY: the provider serialised a JSON object; anything else is passed through untouched.
		const parsed = JSON.parse(body) as unknown
		if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return body
		const request = parsed as Record<string, unknown>
		const existing =
			typeof request.trace === "object" && request.trace !== null ? request.trace : undefined
		return JSON.stringify({
			...request,
			trace: { ...existing, trace_id: span.traceId, parent_span_id: span.spanId },
		})
	} catch {
		return body
	}
}
