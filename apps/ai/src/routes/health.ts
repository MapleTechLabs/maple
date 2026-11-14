/**
 * Liveness, answered without touching the layer graph, the database, or a
 * binding: a check that builds the graph reports the graph's health, which is
 * the thing most likely to be broken when you ask. `makeFetch` answers it before
 * it picks a graph, so no router carries the route.
 */
import { Config, Effect, Option } from "effect"
import { HttpServerResponse } from "effect/http"

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
