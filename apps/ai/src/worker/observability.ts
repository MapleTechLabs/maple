import { Layer } from "effect"
import { HttpMiddleware } from "effect/unstable/http"

/**
 * The one reference `HttpMiddleware.tracer` reads that this Worker has to set
 * itself. The bridge's tracer runs outside the app graph, so it cannot live
 * there — the Worker registers this beside the SDK exporters, exactly as
 * `apps/api/src/http/api-observability.ts` does for the api.
 *
 * Only the filter. Header redaction is left at Effect's defaults
 * (`authorization`, `cookie`, `set-cookie`, `x-api-key`), which already cover
 * every credential reaching this Worker: the provider webhook signatures api
 * adds to its own list are received on api's routes and never forwarded here.
 *
 * `/health` and `OPTIONS` are skipped for the reason CLAUDE.md gives for the
 * api: this Worker's traces land in Maple's own org, so a liveness probe that
 * spans is self-traffic nothing reads.
 */
export const AiObservabilityLive = Layer.succeed(
	HttpMiddleware.TracerDisabledWhen,
	(request: { url: string; method: string }) => request.url === "/health" || request.method === "OPTIONS",
)
