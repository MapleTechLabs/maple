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
import { AuditEventsQueue, MapleDb, prdOnlyBinding } from "@maple/infra/cloudflare"
import { dischargeRuntimeContext } from "@maple/infra/worker-runtime"
import * as Cloudflare from "@alchemy.run/cloudflare"
import { Effect, Layer, Option } from "effect"
import { securityAuditWorkflowControl } from "../security-audit/workflow-control"
import { isWorkersAiBinding, viaGateway, WorkersAiGateway } from "../platform/WorkersAiHttpClient"
import {
	AuditEventsQueueProducer,
	DataSourceDevelopmentCallLimit,
	DataSourceProductionCallLimit,
	McpToolsRateLimit,
	RateLimitBindingError,
	type RateLimiter,
	SecurityAuditWorkflowStarter,
} from "@maple/backend/platform/bindings"
import type { SecurityAuditWorkflowPayload } from "@maple/domain/security-audit"
import { type ChatSessionNamespace, layerChatSessions } from "@maple/backend/platform/chat-sessions"
import { envPorts } from "@maple/backend/platform/env-ports"
import { layerMapleDbConnection } from "@maple/backend/platform/pg-connection-source"
import { queueProducer } from "@maple/backend/platform/queue-producer"
import {
	MCP_TOOLS_RATE_LIMIT_PERIOD_SECONDS,
	MCP_TOOLS_RATE_LIMIT_REQUESTS,
} from "@maple/backend/services/auth/McpToolRateLimiter"
import { DATA_SOURCE_CALL_LIMITS } from "@maple/backend/services/data-sources/DataSourceCallBudgetLive"

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
		// Maple's share of each connected Clerk instance's API limit, keyed by data source id.
		// Shared by every worker that queries sources, so the namespace ids must match across them.
		dataSourceProductionCallLimit: yield* Cloudflare.RateLimit("DATA_SOURCE_PRODUCTION_CALL_LIMITER", {
			namespaceId: 2026110801,
			simple: DATA_SOURCE_CALL_LIMITS.production,
		}),
		dataSourceDevelopmentCallLimit: yield* Cloudflare.RateLimit("DATA_SOURCE_DEVELOPMENT_CALL_LIMITER", {
			namespaceId: 2026110802,
			simple: DATA_SOURCE_CALL_LIMITS.development,
		}),
		// Audited tool calls send here after the response, as api's requests do; api consumes it.
		auditEvents: yield* Cloudflare.Queues.WriteQueue(AuditEventsQueue),
	}
})

type AiBindingClients = Effect.Success<typeof bindAiClients>

/**
 * The AI Gateway Workers AI calls route through. The logical id is the api's, unchanged: the
 * gateway's Cloudflare id derives from it, so renaming it mints a new gateway and abandons its logs.
 */
const AiGateway = Cloudflare.AI.Gateway("maple-api-ai")

/**
 * Bind the gateway and resolve it to a Workers AI binding whose calls carry the gateway id.
 * prd only: dev has no local emulation of it, and the account caps gateways at 20. Elsewhere
 * nothing is bound and the graph calls Workers AI directly.
 */
const bindWorkersAiGateway = prdOnlyBinding(Cloudflare.AI.QueryGateway(AiGateway), (client) =>
	Effect.gen(function* () {
		const raw = yield* dischargeRuntimeContext(client.raw)
		if (!isWorkersAiBinding(raw)) return Option.none()
		const id = yield* dischargeRuntimeContext(client.id)
		return Option.some(viaGateway(raw, id))
	}),
)

/**
 * The gateway binding as a service, for the fetch graph's ports and the chat Durable Object's
 * activation alike. One layer value, so the init builds it once.
 */
export const WorkersAiGatewayLive = Layer.effect(WorkersAiGateway, bindWorkersAiGateway).pipe(
	Layer.provide(Cloudflare.AI.QueryGatewayBinding),
)

/** The binding layers the init needs. */
export const AiBindingsLive = Layer.mergeAll(
	Cloudflare.Hyperdrive.ConnectBinding,
	Cloudflare.Workers.RateLimitBinding,
	Cloudflare.Queues.WriteQueueBinding,
	WorkersAiGatewayLive,
)

const limiter = (client: Cloudflare.Workers.RateLimitClient): RateLimiter => ({
	limit: (key) =>
		dischargeRuntimeContext(client.limit({ key })).pipe(
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
 * (`envPorts`: the env itself, the `ConfigProvider`, the sandbox service binding) and the
 * `ChatSessions` port over the namespace this Worker hosts: the one place a graph in this Worker
 * gets its env from.
 */
export const aiPorts = (
	clients: AiBindingClients,
	env: Record<string, unknown>,
	workersAi: typeof WorkersAiGateway.Service,
	chatSessions: ChatSessionNamespace,
	audits: Cloudflare.WorkflowHandle<SecurityAuditWorkflowPayload>,
) =>
	Layer.mergeAll(
		Layer.succeed(WorkersAiGateway, workersAi),
		Layer.succeed(SecurityAuditWorkflowStarter, securityAuditWorkflowControl(audits)),
		Layer.succeed(McpToolsRateLimit, limiter(clients.mcpToolsRateLimit)),
		Layer.succeed(DataSourceProductionCallLimit, limiter(clients.dataSourceProductionCallLimit)),
		Layer.succeed(DataSourceDevelopmentCallLimit, limiter(clients.dataSourceDevelopmentCallLimit)),
		Layer.succeed(AuditEventsQueueProducer, queueProducer(clients.auditEvents)),
		layerMapleDbConnection(env),
		envPorts(env),
		layerChatSessions(chatSessions, env),
	)

export type AiPortsLayer = ReturnType<typeof aiPorts>
