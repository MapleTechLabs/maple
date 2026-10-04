/**
 * Liveness, answered without touching the layer graph, the database, or a
 * binding — a check that builds the graph reports the graph's health, which is
 * the thing most likely to be broken when you ask.
 *
 * A raw router rather than an `HttpApi` endpoint so it stays outside the typed
 * surface entirely, matching the api's own `/health`.
 */
import { Config, Effect, Option } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/http"

/** The revision this isolate runs, so a deploy can assert the script now serving is the one it uploaded. */
export const healthResponse = Effect.map(
	Effect.orElseSucceed(Config.option(Config.String("COMMIT_SHA")), () => Option.none<string>()),
	(revision) =>
		HttpServerResponse.text("OK", {
			headers: Option.match(revision, {
				onNone: () => undefined,
				onSome: (sha) => ({ "x-maple-revision": sha }),
			}),
		}),
)

export const HealthRouter = HttpRouter.use((router) => router.add("GET", "/health", () => healthResponse))
