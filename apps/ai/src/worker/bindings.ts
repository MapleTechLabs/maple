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
import { MapleDb, parseMapleDeployment } from "@maple/infra/cloudflare"
import * as Cloudflare from "alchemy/Cloudflare"
import { RuntimeContext } from "alchemy/RuntimeContext"
import { Stage } from "alchemy/Stage"
import { Effect, Layer, Option } from "effect"
import { isWorkersAiBinding, viaGateway, WorkersAiGateway } from "../platform/WorkersAiHttpClient"
import { McpToolsRateLimit, RateLimitBindingError, type RateLimiter } from "@maple/backend/platform/bindings"
import { envPorts } from "@maple/backend/platform/env-ports"
import { mapleDbConnectionLayer } from "@maple/backend/platform/pg-connection-source"
import {
	MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS,
	MCP_TOOLS_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/auth/McpToolRateLimiter"

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

/** Discharge alchemy's phantom color, the way alchemy's own runtime helpers do. */
const runtime = <A, E>(effect: Effect.Effect<A, E, RuntimeContext>): Effect.Effect<A, E> =>
	// oxlint-disable-next-line effecttsgo/strict-effect-provide
	Effect.provide(effect, RuntimeContext.phantom)

/**
 * The AI Gateway Workers AI calls route through. The logical id is the api's, unchanged: the
 * gateway's Cloudflare id derives from it, so renaming it mints a new gateway and abandons its logs.
 */
const AiGateway = Cloudflare.AI.Gateway("maple-api-ai")

/**
 * Bind the gateway and resolve it to a Workers AI binding whose calls carry the gateway id.
 *
 * Deployed stages only: the gateway has no local emulation, so declaring it under `alchemy dev`
 * diffs it against Cloudflare and demands a login. The stage is known only at plan time; in the
 * isolate the binding is either on the env or not, and a dev isolate reads none.
 */
const bindWorkersAiGateway = Effect.gen(function* () {
	if (!globalThis.__ALCHEMY_RUNTIME__ && parseMapleDeployment(yield* Stage).stage.kind === "dev") {
		return Option.none()
	}
	const client = yield* Cloudflare.AI.QueryGateway(AiGateway)
	if (!globalThis.__ALCHEMY_RUNTIME__) return Option.none()
	const raw = yield* runtime(client.raw)
	if (!isWorkersAiBinding(raw)) return Option.none()
	return Option.some(viaGateway(raw, yield* runtime(client.id)))
})

/**
 * The gateway binding as a service, for the fetch graph's ports and the chat Durable Object's
 * activation alike. One layer value, so the init builds it once.
 */
export const WorkersAiGatewayLive = Layer.effect(WorkersAiGateway, bindWorkersAiGateway).pipe(
	Layer.provide(Cloudflare.AI.QueryGatewayBinding),
)

/** The binding layers the init needs. */
export const AiBindingLayers = Layer.mergeAll(
	Cloudflare.Hyperdrive.ConnectBinding,
	Cloudflare.Workers.RateLimitBinding,
	WorkersAiGatewayLive,
)

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
 * The ports the service graph depends on, plus the env-backed ports
 * (`envPorts`: the env itself, the `ConfigProvider`, chat sessions, the sandbox
 * service binding) — the one place a graph in this Worker gets its env from.
 */
export const aiPorts = (
	clients: AiBindingClients,
	env: Record<string, unknown>,
	workersAi: typeof WorkersAiGateway.Service,
) =>
	Layer.mergeAll(
		Layer.succeed(WorkersAiGateway, workersAi),
		Layer.succeed(McpToolsRateLimit, limiter(clients.mcpToolsRateLimit)),
		mapleDbConnectionLayer(env),
		envPorts(env),
	)

export type AiPortsLayer = ReturnType<typeof aiPorts>
