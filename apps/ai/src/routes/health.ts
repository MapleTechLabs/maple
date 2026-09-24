/**
 * Liveness, answered without touching the layer graph, the database, or a
 * binding — a check that builds the graph reports the graph's health, which is
 * the thing most likely to be broken when you ask.
 *
 * A raw router rather than an `HttpApi` endpoint so it stays outside the typed
 * surface entirely, matching the api's own `/health`.
 */
import * as Cloudflare from "alchemy/Cloudflare"
import { Effect } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"

export const HealthRouter = HttpRouter.use((router) =>
	router.add("GET", "/health", () =>
		Effect.gen(function* () {
			// The revision this isolate runs, so a deploy can assert the script now
			// serving is the one it just uploaded.
			const revision = (yield* Cloudflare.WorkerEnvironment).COMMIT_SHA
			return HttpServerResponse.text("OK", {
				headers: typeof revision === "string" ? { "x-maple-revision": revision } : undefined,
			})
		}),
	),
)
