/**
 * The AI Worker's bindings, on alchemy's capabilities — the same shape as
 * apps/api's: the init yields one typed client per resource it reaches at
 * runtime, which attaches the native binding at plan time and reads it off the
 * env in the isolate, and the clients become the Maple-owned ports the service
 * graph depends on.
 *
 * Far fewer than api's, because the agents write through api's services rather
 * than reaching resources directly. What is here is what the MCP transport and
 * the tool registry touch on their own.
 */
import { MapleDb } from "@maple/infra/cloudflare"
import { workerEnvLayer } from "@maple/infra/worker-runtime"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Effect, Layer } from "effect"
import { McpToolsRateLimit, RateLimitBindingError, type RateLimiter } from "@/platform/bindings"
import { mapleDbConnectionLayer } from "@/platform/pg-connection-source"
import {
	MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS,
	MCP_TOOLS_RATE_LIMIT_REQUESTS,
} from "@/services/auth/McpToolRateLimiter"

export const bindAiClients = Effect.gen(function* () {
	// `MAPLE_DB` in the stage's flavor. The agents read and write the same
	// application database api does — investigations, error issues, dashboards —
	// so this is a connection budget of its own, not a share of api's.
	yield* MapleDb("ai")
	return {
		// Authenticated POST /mcp, per credential. A short window so a runaway
		// agent loop is cut off in seconds, at twice the v2 API's throughput.
		//
		// The `namespaceId` is carried over from apps/api unchanged: it is the
		// Cloudflare-side identity of the bucket, so a new one would silently reset
		// every client's budget at the cutover.
		mcpToolsRateLimit: yield* Cloudflare.RateLimit("MCP_TOOLS_RATE_LIMITER", {
			namespaceId: 2026082901,
			simple: { limit: MCP_TOOLS_RATE_LIMIT_REQUESTS, period: MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS },
		}),
	}
})

type AiBindingClients = Effect.Success<typeof bindAiClients>

/** The binding layers the init needs. */
export const AiBindingLayers = Layer.mergeAll(
	Cloudflare.Hyperdrive.ConnectBinding,
	Cloudflare.Workers.RateLimitBinding,
)

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	effect as Effect.Effect<A, E>

const limiter = (client: Cloudflare.Workers.RateLimitClient): RateLimiter => ({
	limit: (key) =>
		runtime(client.limit({ key })).pipe(
			Effect.mapError(
				(error) =>
					new RateLimitBindingError({
						message: "Cloudflare rate-limit binding call failed",
						cause: error.cause,
					}),
			),
		),
})

/**
 * The ports the service graph depends on, plus the env itself as
 * `WorkerEnvironment` and the `ConfigProvider` — the one place a graph in this
 * Worker gets its env from.
 */
export const aiPorts = (clients: AiBindingClients, env: Record<string, unknown>) =>
	Layer.mergeAll(
		Layer.succeed(McpToolsRateLimit, limiter(clients.mcpToolsRateLimit)),
		mapleDbConnectionLayer(env),
		workerEnvLayer(env),
	)

export type AiPortsLayer = ReturnType<typeof aiPorts>
