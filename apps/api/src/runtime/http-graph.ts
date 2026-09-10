import { MapleApi, MapleInternalApi } from "@maple/domain/http"
import { MapleApiV2 } from "@maple/domain/http/v2"
import { Layer } from "effect"
import { HttpRouter, HttpServerResponse } from "effect/unstable/http"
import { HttpApiBuilder, HttpApiScalar } from "effect/unstable/httpapi"
import { API_CORS_OPTIONS } from "@/http/api-cors"
import { McpLive } from "@/mcp/app"
import { Env } from "@/platform/Env"
import { HttpAiModelsInternalLive } from "@/routes/internal/ai-models.http"
import { HttpAiSessionsInternalLive } from "@/routes/internal/ai-sessions.http"
import { HttpAiTriageLive } from "@/routes/internal/ai-triage.http"
import { HttpAuthLive, HttpAuthPublicLive } from "@/routes/v1/auth.http"
import { HttpBillingLive } from "@/routes/internal/billing.http"
import { HttpBillingPublicLive } from "@/routes/v1/billing-public.http"
import { HttpV2SharePublicLive } from "@/routes/v2/share.http"
import { ChatSessionsRouter } from "@/routes/v1/chat-sessions.http"
import { HttpChatLive } from "@/routes/internal/chat.http"
import { V1ErrorBoundaryLive } from "@/routes/v1/error-boundary"
import { HttpDemoLive } from "@/routes/internal/demo.http"
import { DiscoveryRouter, NotFoundRouter } from "@/routes/discovery.http"
import { HttpDigestLive } from "@/routes/internal/digest.http"
import { HttpErrorsLive } from "@/routes/v1/errors.http"
import { HttpIntegrationsLive, IntegrationsCallbackRouter } from "@/routes/v1/integrations.http"
import { OAuthDiscoveryRouter } from "@/routes/v1/oauth-discovery.http"
import { HttpOrgClickHouseSettingsLive } from "@/routes/v1/org-clickhouse-settings.http"
import { HttpOrganizationsLive } from "@/routes/v1/organizations.http"
import { PlanetScaleWebhookRouter } from "@/routes/v1/planetscale-webhook.http"
import { HttpQueryEngineLive } from "@/routes/internal/query-engine.http"
import { HttpSessionReplaysInternalLive } from "@/routes/internal/session-replays.http"
import { ScraperInternalRouter } from "@/routes/v1/scraper-internal.http"
import { HttpSessionReplaysLive } from "@/routes/v1/session-replay.http"
import { SlackCallbackRouter, SlackInternalRouter } from "@/routes/v1/slack-integration.http"
import { VcsWebhookRouter } from "@/routes/v1/vcs-webhook.http"
import { AutumnWebhookRouter } from "@/routes/webhooks/autumn.http"
import { ClerkWebhookRouter } from "@/routes/webhooks/clerk.http"
import { HttpV2AlertDeliveriesLive } from "@/routes/v2/alert-deliveries.http"
import { HttpV2AlertDestinationsLive } from "@/routes/v2/alert-destinations.http"
import { HttpV2AlertIncidentsLive } from "@/routes/v2/alert-incidents.http"
import { HttpV2AlertRulesLive } from "@/routes/v2/alert-rules.http"
import { HttpV2AnomaliesLive } from "@/routes/v2/anomalies.http"
import { HttpV2ApiKeysLive } from "@/routes/v2/api-keys.http"
import { HttpV2AttributeMappingsLive } from "@/routes/v2/attribute-mappings.http"
import { HttpV2DashboardsLive } from "@/routes/v2/dashboards.http"
import { V2TransportErrorBoundaryLive } from "@/routes/v2/error-envelope"
import { HttpV2ErrorIssuesLive } from "@/routes/v2/error-issues.http"
import { HttpV2IngestKeysLive } from "@/routes/v2/ingest-keys.http"
import { HttpV2PlanetScaleIntegrationsLive, HttpV2SlackIntegrationsLive } from "@/routes/v2/integrations.http"
import { HttpV2InvestigationsLive } from "@/routes/v2/investigations.http"
import { HttpV2MobileDevicesLive } from "@/routes/v2/mobile-devices.http"
import { HttpV2OrganizationLive } from "@/routes/v2/organization.http"
import { HttpV2InstrumentationRecommendationsLive } from "@/routes/v2/recommendations.http"
import { HttpV2AuditLogLive } from "@/routes/v2/audit-log.http"
import { AuditLogServiceLive } from "@/runtime/service-graph"
import { HttpV2ScrapeTargetsLive } from "@/routes/v2/scrape-targets.http"
import { HttpV2InstrumentationAuditLive } from "@/routes/v2/setup-audit.http"
import { HttpV2SessionReplaysLive } from "@/routes/v2/session-replays.http"
import {
	HttpV2EnvironmentsLive,
	HttpV2LogsLive,
	HttpV2MetricsLive,
	HttpV2ServiceMapLive,
	HttpV2ServicesLive,
	HttpV2TracesLive,
} from "@/routes/v2/telemetry.http"
import { HttpV2WidgetSummaryLive } from "@/routes/v2/widget-summary.http"
import { HttpV2WidgetCredentialsLive } from "@/routes/v2/widget-credentials.http"
import { ApiAuthorizationLayer } from "@/services/auth/ApiAuthorizationLayer"
import { ApiAuthorizationV2Layer } from "@/services/auth/ApiAuthorizationV2Layer"
import { SessionAuthorizationLayer } from "@/services/auth/SessionAuthorizationLayer"
import { ApiV2RateLimiter } from "@/services/auth/ApiV2RateLimiter"
import { McpToolRateLimiter } from "@/services/auth/McpToolRateLimiter"
import { EdgeCacheServiceLive } from "@/platform/CacheBackendLive"
import { OrgMembershipService } from "@/services/auth/OrgMembershipService"
import { ApiKeysService } from "@/services/org/ApiKeysService"
import type { ApiPortsLayer } from "@/worker/bindings"

const HealthRouter = HttpRouter.use((router) => router.add("GET", "/health", HttpServerResponse.text("OK")))

// `layerCdn` loads Scalar's browser bundle from jsDelivr at runtime instead of
// inlining its ~MB `standalone.min.js` string into the worker bundle — keeps the
// script out of the deployed bundle (guards the 3 MB worker size limit, error
// 10027). The `/docs` page now depends on jsDelivr being reachable from the
// client browser.
const DocsRoute = HttpApiScalar.layerCdn(MapleApi, {
	path: "/docs",
})

// Public v2 API reference (only v2 groups — the internal v1 surface stays on /docs).
const DocsV2Route = HttpApiScalar.layerCdn(MapleApiV2, {
	path: "/v2/docs",
})

const ApiRoutes = HttpApiBuilder.layer(MapleApi).pipe(
	Layer.provide(HttpAuthPublicLive),
	Layer.provide(HttpAuthLive),
	Layer.provide(HttpBillingPublicLive),
	Layer.provide(HttpErrorsLive),
	Layer.provide(HttpIntegrationsLive),
	Layer.provide(HttpOrgClickHouseSettingsLive),
	Layer.provide(HttpOrganizationsLive),
	Layer.provide(HttpSessionReplaysLive),
	Layer.provide(V1ErrorBoundaryLive),
)

/**
 * The dashboard's private transport, served under `/internal/*`.
 *
 * Session-only: `SessionAuthorizationLayer` refuses API-key-shaped bearers, so
 * nothing here is reachable as public API. It is also absent from `/docs`,
 * which is generated from `MapleApi`.
 */
const ApiInternalRoutes = HttpApiBuilder.layer(MapleInternalApi).pipe(
	Layer.provide(
		Layer.mergeAll(
			HttpQueryEngineLive,
			HttpSessionReplaysInternalLive,
			HttpAiSessionsInternalLive,
			HttpAiModelsInternalLive,
		),
	),
	Layer.provide(
		Layer.mergeAll(HttpAiTriageLive, HttpBillingLive, HttpChatLive, HttpDemoLive, HttpDigestLive),
	),
	Layer.provide(V1ErrorBoundaryLive),
)

const ApiV2Routes = HttpApiBuilder.layer(MapleApiV2).pipe(
	Layer.provide(
		Layer.mergeAll(
			HttpV2ApiKeysLive,
			HttpV2DashboardsLive,
			HttpV2AlertDeliveriesLive,
			HttpV2AlertRulesLive,
			HttpV2AlertDestinationsLive,
			HttpV2AlertIncidentsLive,
			HttpV2IngestKeysLive,
			HttpV2SlackIntegrationsLive,
			HttpV2PlanetScaleIntegrationsLive,
			HttpV2ErrorIssuesLive,
			HttpV2AttributeMappingsLive,
			HttpV2AuditLogLive,
			HttpV2ScrapeTargetsLive,
			HttpV2InstrumentationRecommendationsLive,
			HttpV2InstrumentationAuditLive,
			HttpV2SharePublicLive,
			HttpV2InvestigationsLive,
			HttpV2AnomaliesLive,
			HttpV2OrganizationLive,
			HttpV2MobileDevicesLive,
			HttpV2SessionReplaysLive,
			HttpV2TracesLive,
			HttpV2LogsLive,
			HttpV2MetricsLive,
			HttpV2ServicesLive,
			HttpV2ServiceMapLive,
			HttpV2EnvironmentsLive,
			HttpV2WidgetSummaryLive,
			HttpV2WidgetCredentialsLive,
		),
	),
	Layer.provide(V2TransportErrorBoundaryLive),
)

/**
 * Services a raw router's handlers still expect from the request context, beyond the Worker's
 * ports, which every request carries. Each is a runtime "Service not found".
 */
type LeakedRequestServices<Routes extends Layer.Any> =
	Layer.Services<Routes> extends infer Marker
		? Marker extends HttpRouter.Request<"Requires", infer Service>
			? Exclude<Service, Layer.Success<ApiPortsLayer>>
			: never
		: never

/**
 * A raw `HttpRouter` handler runs in the request's own context — unlike an `HttpApiBuilder`
 * group, nothing carries the router's build context into it — so a service it reads per request
 * has to arrive through `HttpRouter.provideRequest` (see `ChatSessionsRouter`). Read inside the
 * handler instead, it compiles, because the isolate builder erases the marker, and fails every
 * request with "Service not found", which is what took the chat routes down on 2026-09-08. This
 * turns that into a build failure naming the leaked service.
 */
const rawRoutes = <Routes extends Layer.Any>(
	routes: Routes &
		([LeakedRequestServices<Routes>] extends [never]
			? unknown
			: { readonly leakedRequestServices: LeakedRequestServices<Routes> }),
) => routes

const RawRoutes = rawRoutes(
	Layer.mergeAll(
		ChatSessionsRouter,
		IntegrationsCallbackRouter,
		SlackCallbackRouter,
		SlackInternalRouter,
		OAuthDiscoveryRouter,
		PlanetScaleWebhookRouter,
		ScraperInternalRouter,
		VcsWebhookRouter,
		ClerkWebhookRouter,
		AutumnWebhookRouter,
		McpLive,
		HealthRouter,
		DocsRoute,
		DocsV2Route,
		DiscoveryRouter,
		// Last by convention only — find-my-way ranks the wildcard below every other
		// route regardless of registration order.
		NotFoundRouter,
	),
)

export const AllRoutes = Layer.mergeAll(ApiRoutes, ApiInternalRoutes, ApiV2Routes, RawRoutes).pipe(
	Layer.provideMerge(HttpRouter.cors(API_CORS_OPTIONS)),
)

export const ApiAuthLive = Layer.mergeAll(
	ApiAuthorizationLayer,
	ApiAuthorizationV2Layer,
	SessionAuthorizationLayer,
).pipe(
	Layer.provideMerge(ApiV2RateLimiter.layer),
	Layer.provideMerge(McpToolRateLimiter.layer),
	Layer.provideMerge(ApiKeysService.layer),
	// Denied attempts and audited reads are recorded from inside the auth layers.
	Layer.provideMerge(AuditLogServiceLive),
	// Membership verification for `x-maple-org-id`. Only the v2 layer asks for
	// it; without it that layer cannot build, which is deliberate — the header
	// must never end up silently ignored in a runtime that forgot to wire this.
	Layer.provideMerge(OrgMembershipService.layer.pipe(Layer.provide(EdgeCacheServiceLive))),
	Layer.provideMerge(Env.layer),
)
