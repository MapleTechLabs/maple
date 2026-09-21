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
import { McpOAuthService } from "@maple/backend/services/auth/McpOAuthService"

import { DailySpendService } from "@maple/backend/services/billing/DailySpendService"
import { AutumnClient } from "@maple/backend/services/billing/autumn-http"
import { StripeClient } from "@maple/backend/services/billing/stripe-http"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { SharedDashboardService } from "@maple/backend/services/dashboards/SharedDashboardService"
import { DashboardWidgetDataService } from "@maple/backend/services/dashboards/DashboardWidgetDataService"
import { DigestService } from "@maple/backend/services/digest/DigestService"
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
import { PlanetScaleConnectionService } from "@maple/backend/services/integrations/PlanetScaleConnectionService"
import { PlanetScaleDiscoveryService } from "@maple/backend/services/integrations/PlanetScaleDiscoveryService"
import { PlanetScaleService } from "@maple/backend/services/integrations/PlanetScaleService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { ChatWorkspaceService } from "@maple/backend/services/integrations/ChatWorkspaceService"
import { SlackIntegrationService } from "@maple/backend/services/integrations/SlackIntegrationService"
import { TinybirdOrgTokenService } from "@maple/backend/services/integrations/TinybirdOrgTokenService"
import { PlanetScaleWebhookQueue } from "@maple/backend/services/integrations/planetscale/PlanetScaleWebhookQueue"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { VcsRepository } from "@maple/backend/services/integrations/vcs/VcsRepository"
import { VcsSyncQueue } from "@maple/backend/services/integrations/vcs/VcsSyncQueue"
import { GithubConnectService } from "@maple/backend/services/integrations/vcs/vendor/github/GithubConnectService"
import { ApiKeysService } from "@maple/backend/services/org/ApiKeysService"
import { DemoService } from "@maple/backend/services/org/DemoService"
import { IngestAttributeMappingService } from "@maple/backend/services/org/IngestAttributeMappingService"
import { OnboardingChecklistService } from "@maple/backend/services/org/OnboardingChecklistService"
import { OnboardingService } from "@maple/backend/services/org/OnboardingService"
import { OrgIngestKeysService } from "@maple/backend/services/org/OrgIngestKeysService"
import { OrgMembersService } from "@maple/backend/services/org/OrgMembersService"
import { OrganizationService } from "@maple/backend/services/org/OrganizationService"
import { LiveActivitiesService } from "@maple/backend/services/push/LiveActivitiesService"
import { MobileDevicesService } from "@maple/backend/services/push/MobileDevicesService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { SignalPresenceService } from "@maple/backend/services/org/SignalPresenceService"
import { ProductEventsService } from "@maple/backend/services/product-events/ProductEventsService"

import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { OrgClickHouseSettingsService } from "@maple/backend/services/org/OrgClickHouseSettingsService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"

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
	CloudflareOAuthService.layer,
	DashboardPersistenceService.layer,
	SharedDashboardService.layer,
	HazelOAuthService.layer,
	OnboardingService.layer,
	OnboardingChecklistService.layer,
	OrgIngestKeysService.layer,
	OrgClickHouseSettingsService.layer,
	TinybirdOrgTokenService.layer,
	OrganizationService.layer,
	MobileDevicesService.layer,
	LiveActivitiesService.layer,
	PlanetScaleWebhookQueue.layer,
	ScrapeTargetsService.layer,
	PlanetScaleConnectionService.layer,
	PlanetScaleService.layer,
	IngestAttributeMappingService.layer,
	AutumnClient.layer,
	StripeClient.layer,
	ProductEventsService.layer,
	DailySpendService.layer,
	CloudflareAnalyticsService.layer,
	AuditLogService.layer,
	WarehouseQueryService.layer,
	QueryEngineService.layer,
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
	DigestService.layer,
	DemoService.layer,
	GithubConnectService.layer,
	VcsCommitService.layer,
	VcsSourceService.layer,
	SlackIntegrationService.layer,
	ChatWorkspaceService.layer,
).pipe(
	Layer.provide(PullRequestLookupLive),
	Layer.provideMerge(Layer.mergeAll(Env.layer, EdgeCacheServiceLive)),
)
