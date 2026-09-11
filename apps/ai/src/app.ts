/**
 * The AI worker's request surface.
 *
 * Imported lazily from `worker.ts` so the graph it will carry — the MCP
 * transport, the chat routes, and the service layers under both — stays off the
 * startup path, where Cloudflare evaluates module scope under a fixed CPU budget
 * and 47 tool schemas have already exhausted it once.
 *
 * Only `/health` lives here today. It answers before any graph exists, which is
 * what makes it useful: it says the isolate booted and its bindings resolved,
 * not that the database is reachable.
 */
import { Effect } from "effect"
import { HttpServerResponse } from "effect/unstable/http"

export const fetch = Effect.succeed(HttpServerResponse.text("ok"))
