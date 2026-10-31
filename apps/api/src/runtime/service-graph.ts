import { VcsProviderRegistry } from "@maple/backend/services/integrations/vcs/VcsProviderRegistry"
import { Layer } from "effect"
import { EdgeCacheServiceLive } from "@maple/backend/platform/CacheBackendLive"

import { Env } from "@maple/backend/platform/Env"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertDestinationsService } from "@maple/backend/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { AnomalyDetectionService } from "@maple/backend/services/alerts/AnomalyDetectionService"

import { PlanetScaleOAuthService } from "@maple/backend/services/auth/PlanetScaleOAuthService"
import { AuthService } from "@maple/backend/services/auth/AuthService"
import { CliDeviceAuthService } from "@maple/backend/services/auth/CliDeviceAuthService"
import { CloudflareOAuthService } from "@maple/backend/services/auth/CloudflareOAuthService"
import { HazelOAuthService } from "@maple/backend/services/auth/HazelOAuthService"
import { LinearOAuthService } from "@maple/backend/services/auth/LinearOAuthService"
import { McpConnectionsService } from "@maple/backend/services/auth/McpConnectionsService"
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"
import { PreviewSignInService } from "@maple/backend/services/auth/PreviewSignInService"

import { DailySpendService } from "@maple/backend/services/billing/DailySpendService"
import { BillingCustomerResolver } from "@maple/backend/services/billing/BillingCustomerResolver"
import { BillingOrgService } from "@maple/backend/services/billing/BillingOrgService"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { StripeClient } from "@maple/backend/services/billing/stripe-http"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { DashboardWidgetDataService } from "@maple/backend/services/dashboards/DashboardWidgetDataService"
import { DigestService } from "@maple/backend/services/digest/DigestService"
import { WebAnalyticsDigestService } from "@maple/backend/services/digest/WebAnalyticsDigestService"
import { AiTriageService } from "@maple/backend/services/errors/AiTriageService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { PullRequestLookupLive } from "@maple/backend/services/errors/pull-request-lookup-live"
import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { IncidentClassifier } from "@maple/backend/services/errors/IncidentClassifier"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"
import { CloudflareAnalyticsService } from "@maple/backend/services/integrations/CloudflareAnalyticsService"
import { AwsConnectionService } from "@maple/backend/services/integrations/AwsConnectionService"
import { AwsIngestService } from "@maple/backend/services/integrations/AwsIngestService"
import { GcpConnectorService } from "@maple/backend/services/integrations/GcpConnectorService"
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "@maple/backend/services/integrations/PlanetScaleDiscoveryService"
import { PlanetScaleService } from "@maple/backend/services/integrations/PlanetScaleService"
import { PlanetScaleWebhookService } from "@maple/backend/services/integrations/PlanetScaleWebhookService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { SupabaseConnectionService } from "@maple/backend/services/integrations/SupabaseConnectionService"
import { SupabaseInsightsService } from "@maple/backend/services/integrations/SupabaseInsightsService"
import { SupabaseLogsService } from "@maple/backend/services/integrations/SupabaseLogsService"
import { SupabaseOAuthService } from "@maple/backend/services/auth/SupabaseOAuthService"
import { OrgOpenRouterKeyService } from "@maple/backend/services/org/OrgOpenRouterKeyService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import { StatusPagePublisher } from "@maple/backend/services/status-pages/StatusPagePublisher"
import { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { TinybirdOrgTokenService } from "@maple/backend/services/integrations/TinybirdOrgTokenService"
import { PlanetScaleWebhookQueue } from "@maple/backend/services/integrations/planetscale/PlanetScaleWebhookQueue"
import { CancellationReviewService } from "@maple/backend/services/cancellation-review/CancellationReviewService"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { DemoService } from "@maple/backend/services/org/DemoService"
import { IngestAttributeMappingService } from "@maple/backend/services/org/IngestAttributeMappingService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { OnboardingChecklistService } from "@maple/backend/services/org/OnboardingChecklistService"
import { SupportChannelService } from "@maple/backend/services/support/SupportChannelService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { SourceRemovalService } from "@maple/backend/services/integrations/SourceRemovalService"
import { SourceUsageService } from "@maple/backend/services/org/SourceUsageService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import { SessionReplayReadService } from "@maple/backend/services/session-replays/SessionReplayReadService"
import { ProductEventsService } from "@maple/backend/services/product-events/ProductEventsService"

import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { TelemetryReadService } from "@maple/backend/services/warehouse/TelemetryReadService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { CiAnalyticsService } from "@maple/backend/services/pr-review/CiAnalyticsService"
import { CodeReviewTeamService } from "@maple/backend/services/pr-review/CodeReviewTeamService"
import { PrReviewAnalyticsService } from "@maple/backend/services/pr-review/PrReviewAnalyticsService"

/** Services consumed by HTTP routes; each service owns its implementation dependencies. */
export const HttpServicesLive = Layer.mergeAll(
	VcsProviderRegistry.layer,
	OrgMembersService.layer,
	PlanetScaleDiscoveryService.layer,
	PlanetScaleOAuthService.layer,
	VcsRepository.layer,
	VcsSyncQueue.layer,
	AuthService.layer,
	ApiKeysService.layer,
	CliDeviceAuthService.layer,
	McpOAuthService.layer,
	McpConnectionsService.layer,
	PreviewSignInService.layer,
	CloudflareOAuthService.layer,
	DashboardPersistenceService.layer,
	SharedDashboardService.layer,
	HazelOAuthService.layer,
	LinearOAuthService.layer,
	OnboardingService.layer,
	OnboardingChecklistService.layer,
	SupportChannelService.layer,
	OrgIngestKeysService.layer,
	SourcesService.layer,
	SourceUsageService.layer,
	OrgClickHouseSettingsService.layer,
	TinybirdOrgTokenService.layer,
	OrganizationService.layer,
	MobileDevicesService.layer,
	AgentFeedbackService.layer,
	LiveActivitiesService.layer,
	PlanetScaleWebhookQueue.layer,
	CancellationReviewService.layer,
	ScrapeTargetsService.layer,
	UptimeMonitorsService.layer,
	StatusPagesService.layer,
	// The `statusPages` rollout gate on the status page routes.
	OrganizationFeatureFlagsService.layer,
	// Read-only: previews of unsaved pages.
	StatusPageSnapshotBuilder.layer,
	// Needs the `StatusPageStore` port, which only the deployed Worker binds.
	StatusPagePublisher.layer,
	PlanetScaleConnectionService.layer,
	PlanetScaleService.layer,
	PlanetScaleWebhookService.layer,
	IngestAttributeMappingService.layer,
	IngestRuleService.layer,
	AutumnClient.layer,
	StripeClient.layer,
	ProductEventsService.layer,
	DailySpendService.layer,
	BillingCustomerResolver.layer,
	BillingOrgService.layer,
	CloudflareAnalyticsService.layer,
	RailwayMetricsService.layer,
	SupabaseOAuthService.layer,
	SupabaseConnectionService.layer,
	SupabaseLogsService.layer,
	SupabaseInsightsService.layer,
	GcpConnectorService.layer,
	AwsConnectionService.layer,
	AwsIngestService.layer,
	OrgOpenRouterKeyService.layer,
	AuditLogService.layer,
	WarehouseQueryService.layer,
	QueryEngineService.layer,
	TelemetryReadService.layer,
	DashboardWidgetDataService.layer,
	AlertDestinationsService.layer,
	AlertReadModelsService.layer,
	AlertRulesService.layer,
	AlertsService.layer,
	AnomalyDetectionService.layer,
	AiTriageService.layer,
	InvestigationService.layer,
	ErrorActorsService.layer,
	ErrorIssueWorkflowService.layer,
	ErrorPolicyService.layer,
	ErrorIssueReadModelsService.layer,
	ErrorsService.layer,
	// The investigation gate's classifier, for the alert path that opens
	// incidents from a request. Read optionally by `maybeEnqueueTriage`.
	IncidentClassifier.layer,
	IssueFixVerificationService.layer,
	RecommendationIssueService.layer,
	SetupAuditService.layer,
	SignalPresenceService.layer,
	SessionReplayReadService.layer,
	DigestService.layer,
	WebAnalyticsDigestService.layer,
	DemoService.layer,
	GithubConnectService.layer,
	SourceRemovalService.layer,
	PrReviewAnalyticsService.layer,
	CiAnalyticsService.layer,
	CodeReviewTeamService.layer,
	VcsCommitService.layer,
	VcsSourceService.layer,
	ChatWorkspaceService.layer,
).pipe(
	Layer.provide(PullRequestLookupLive),
	Layer.provideMerge(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)
