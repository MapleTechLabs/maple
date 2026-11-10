import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import { SandboxClient } from "@maple/backend/sandbox/client"
import { CloudflareRepoSandboxLive } from "@maple/backend/services/sandbox/CloudflareRepoSandbox"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertIncidentAckService } from "@maple/backend/services/alerts/AlertIncidentAckService"
import { AlertIncidentPagesService } from "@maple/backend/services/alerts/AlertIncidentPagesService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { EscalationChainsService } from "@maple/backend/services/alerts/EscalationChainsService"
import { AlertMaintenanceWindowsService } from "@maple/backend/services/alerts/AlertMaintenanceWindowsService"
import { OnCallSchedulesService } from "@maple/backend/services/alerts/OnCallSchedulesService"
import { AlertSilencesService } from "@maple/backend/services/alerts/AlertSilencesService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { UsersReadService } from "@maple/backend/services/users/UsersReadService"
import { ErrorIssueMergeService } from "@maple/backend/services/errors/ErrorIssueMergeService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { InvestigationService } from "@maple/backend/services/errors/InvestigationService"
import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"
import { PullRequestLookupLive } from "@maple/backend/services/errors/pull-request-lookup-live"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { SearchConsoleService } from "@maple/backend/services/integrations/SearchConsoleService"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { SlosService } from "@maple/backend/services/slos/SlosService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import { DependencyScanReader } from "@maple/backend/services/dependency-scan/DependencyScanService"
import { RuntimeReleaseCatalog } from "@maple/backend/services/security/RuntimeReleaseCatalog"
import { RuntimeAdvisoryCatalog } from "@maple/backend/services/security/RuntimeAdvisoryCatalog"
import { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { FetchHttpClient } from "effect/http"
import { Layer } from "effect"
import type { ExternalDataSourceService } from "@maple/backend/services/data-sources/ExternalDataSourceService"
import type { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { CurrentMcpTenant } from "../tenant"

/**
 * The application services MCP tool handlers run on, built once per executor. Finite on purpose:
 * a tool with a new dependency compiles only once its layer is added here.
 */
export const McpRuntimeServicesLive = Layer.mergeAll(
	AgentFeedbackService.layer,
	AlertReadModelsService.layer,
	AlertIncidentAckService.layer,
	AlertIncidentPagesService.layer,
	AlertRulesService.layer,
	EscalationChainsService.layer,
	AlertMaintenanceWindowsService.layer,
	OnCallSchedulesService.layer,
	AlertSilencesService.layer,
	AlertsService.layer,
	AuditLogService.layer,
	DashboardPersistenceService.layer,
	DependencyScanReader.layer,
	ErrorActorsService.layer,
	ErrorIssueReadModelsService.layer,
	ErrorIssueWorkflowService.layer,
	ErrorIssueMergeService.layer,
	ErrorPolicyService.layer,
	ErrorsService.layer,
	IntegrationInventoryService.layer,
	SourcesService.layer,
	InvestigationService.layer,
	IssueFixVerificationService.layer,
	QueryEngineService.layer,
	RailwayMetricsService.layer,
	RecommendationIssueService.layer,
	RepoSandboxService.layer,
	RuntimeAdvisoryCatalog.layer,
	RuntimeReleaseCatalog.layer,
	ScrapeTargetsService.layer,
	SearchConsoleService.layer,
	SecurityAuditStore.layer,
	SetupAuditService.layer,
	SlosService.layer,
	StatusPageSnapshotBuilder.layer,
	StatusPagesService.layer,
	UptimeMonitorsService.layer,
	UsersReadService.layer,
	IngestRuleService.layer,
	VcsCommitService.layer,
	VcsSourceService.layer,
	WarehouseQueryService.layer,
).pipe(
	Layer.provide(
		CloudflareRepoSandboxLive.pipe(
			Layer.provide(Layer.mergeAll(VcsSourceService.layer, SandboxClient.layer)),
		),
	),
	Layer.provide(PullRequestLookupLive),
	Layer.provide(FetchHttpClient.layer),
)

/**
 * Every application service a tool handler may use once its request tenant is supplied: the
 * layer above, plus the two the executor's caller provides (`runtime/mcp-tool-graph.ts`).
 */
export type McpToolRuntimeRequirements =
	| Layer.Success<typeof McpRuntimeServicesLive>
	| ExternalDataSourceService
	| OrganizationFeatureFlagsService

/** Every service a raw registered MCP handler may require. */
export type McpToolRequirements = CurrentMcpTenant | McpToolRuntimeRequirements
