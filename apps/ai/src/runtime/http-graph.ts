/**
 * Every route the AI Worker serves except `/mcp`, as one layer. `/mcp` is its
 * own graph (`./mcp-http-graph`), so a cold `/mcp` request never loads these.
 *
 * Several surfaces, and they are deliberately different shapes:
 *
 *   - `/api/chat/sessions/*`: the transport for an investigation's follow-up
 *     conversation, raw because `HttpApi` cannot model an open `text/event-stream`.
 *   - `/internal/chat/apply` — a typed `HttpApi` group, because deciding an
 *     approval-gated proposal is an ordinary request/response with a schema
 *     worth pinning.
 *   - `/internal/mcp/tools`: the public tool catalog for Settings > MCP, typed and
 *     served here because the registry lives in this Worker.
 *   - `/api/security-audit/*`: scheduled security audits, typed and served here because the
 *     Workflow that runs them is hosted in this Worker.
 *   - `/internal/triage/classify` — the decision model behind the investigation
 *     gate, typed for the same reason. Reached only over a service binding: api
 *     does not forward it, and the callers are the Workers that open incidents.
 *
 * The api still owns the hostname and forwards the public ones here over a
 * service binding.
 */
import { MapleAiApi } from "@maple/domain/http"
import { Effect, Layer } from "effect"
import { HttpRouter } from "effect/http"
import { HttpApiBuilder } from "effect/http-api"
import { HttpChatLive } from "../routes/internal/chat.http"
import { HttpTriageLive } from "../routes/internal/triage.http"
import { HttpMcpToolsLive } from "../routes/internal/mcp-tools.http"
import { HttpSecurityAuditLive } from "../routes/security-audit.http"
import { layerDecisionModelFromConfig } from "../platform/Llm"
import { WorkersAiGateway } from "../platform/WorkersAiHttpClient"
import { ChatSessionsRouter } from "../routes/chat-sessions.http"
import { HealthRouter } from "../routes/health"
import { API_CORS_OPTIONS } from "@maple/backend/http/api-cors"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { SecurityAuditCredits } from "@maple/backend/services/security-audit/SecurityAuditCredits"
import { SecurityAuditRepositorySize } from "@maple/backend/services/security-audit/SecurityAuditRepositorySize"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { ApiErrorBoundaryLive } from "@maple/backend/http/error-boundary"
import { rawRoutes } from "./raw-routes"

const RawRoutes = rawRoutes(Layer.mergeAll(HealthRouter, ChatSessionsRouter))

/**
 * The decision model the triage route asks, built once per isolate from the
 * Worker's config: the same layers the investigation turn builds per turn in
 * `turn-runner.ts`, on the same AI Gateway binding.
 */
const DecisionModelLive = Layer.unwrap(Effect.map(WorkersAiGateway, layerDecisionModelFromConfig))

const AiInternalRoutes = HttpApiBuilder.layer(MapleAiApi).pipe(
	Layer.provide(HttpChatLive),
	Layer.provide(HttpMcpToolsLive),
	Layer.provide(
		HttpSecurityAuditLive.pipe(
			Layer.provide(
				Layer.mergeAll(
					SecurityAuditStore.layer,
					OrganizationFeatureFlagsService.layer,
					SecurityAuditCredits.layer,
					SecurityAuditRepositorySize.layer,
				),
			),
		),
	),
	Layer.provide(HttpTriageLive.pipe(Layer.provide(DecisionModelLive))),
	Layer.provide(ApiErrorBoundaryLive),
)

export const AllRoutes = Layer.mergeAll(AiInternalRoutes, RawRoutes).pipe(
	Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)),
)
