/**
 * The AI worker's request surface.
 *
 * Imported lazily from `worker.ts` so the graph it will carry — the MCP
 * transport, the chat routes, and the service layers under both — stays off the
 * startup path, where Cloudflare evaluates module scope under a fixed CPU budget
 * and 47 tool schemas have already exhausted it once.
 *
 * Only `/health` exists today, and it answers the way the api's does: without
 * touching the layer graph, the database, or a binding. That is what makes it
 * worth having — a liveness check that builds the graph reports the graph's
 * health, which is the thing most likely to be broken when you ask. Everything
 * else 404s until the real routes land, so a path that should be served and
 * isn't is visible rather than silently 200.
 */
import { Effect } from "effect"
import { HttpServerRequest, HttpServerResponse } from "effect/unstable/http"

const pathOf = (url: string): string => {
	const query = url.indexOf("?")
	return query === -1 ? url : url.slice(0, query)
}

export const fetch = Effect.gen(function* () {
	const request = yield* HttpServerRequest.HttpServerRequest
	if (request.method === "GET" && pathOf(request.url) === "/health") {
		return HttpServerResponse.text("OK")
	}
	return HttpServerResponse.text("maple-ai: no routes yet", { status: 404 })
})
