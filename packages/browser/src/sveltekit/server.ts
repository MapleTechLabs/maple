// `@maple-dev/browser/sveltekit/server`: joins the page load to the server render.
//
// With SvelteKit's server tracing on (`experimental.tracing.server`, 2.31+),
// every request runs under a `sveltekit.handle.root` span. The page's
// `Server-Timing` header names it, and the browser's `pageload` span becomes
// its child. Depends on `@opentelemetry/api` only.
import { context, trace } from "@opentelemetry/api"
import type { Handle } from "@sveltejs/kit"
import { serverTiming } from "../server"

/**
 * `handle` hook that adds the `Server-Timing` header the page load joins the server trace from.
 * Export it, or put it first in `sequence(mapleHandle, yourHandle)`.
 */
export const mapleHandle: Handle = async ({ event, resolve }) => {
	const response = await resolve(event)
	// Only a document's header reaches the page load. `tracing` is new in 2.31,
	// and its root is a no-op span without server tracing.
	const root = event.tracing?.root
	if (!root || !response.headers.get("content-type")?.startsWith("text/html")) return response
	const value = context.with(trace.setSpan(context.active(), root), serverTiming)
	if (!value) return response
	try {
		response.headers.append("server-timing", value)
		// A 304 revalidation doesn't carry the header: the browser would reuse the
		// cached one, and a reload would join an earlier visit's trace
		response.headers.delete("etag")
	} catch {
		// Immutable headers: a `+server.ts` that returns a `fetch()` response as is
	}
	return response
}
