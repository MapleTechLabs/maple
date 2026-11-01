import type { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import type { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import type { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import type { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import type { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import type { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import type { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import type { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import type { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import type { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import type { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import type { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import type { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"
import type { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import type { SourcesService } from "@maple/backend/services/org/SourcesService"
import type { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import type { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import type { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import type { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import type { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import type { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import type { OrganizationFeatureFlagsService } from "@maple/backend/services/org/OrganizationFeatureFlagsService"
import type { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import type { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import type { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import type { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import type { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import type { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { SecurityAuditStore } from "@maple/backend/services/security-audit/SecurityAuditStore"
import type { DependencyScanReader } from "@maple/backend/services/dependency-scan/DependencyScanService"
import type { RuntimeReleaseCatalog } from "@maple/backend/services/security/RuntimeReleaseCatalog"
import type { RuntimeAdvisoryCatalog } from "@maple/backend/services/security/RuntimeAdvisoryCatalog"
import type { CurrentMcpTenant } from "../lib/query-warehouse"

/**
 * Application services an MCP tool handler may use after its request tenant has
 * been supplied. This is intentionally finite: registering a tool with a new
 * dependency must also extend the executor layer that captures that dependency.
 */
export type McpToolRuntimeRequirements =
	| AgentFeedbackService
	| AlertsService
	| AuditLogService
	| DependencyScanReader
	| AlertReadModelsService
	| AlertRulesService
	| DashboardPersistenceService
	| ErrorActorsService
	| ErrorIssueReadModelsService
	| ErrorIssueWorkflowService
	| ErrorPolicyService
	| ErrorsService
	| IntegrationInventoryService
	| SourcesService
	| IssueFixVerificationService
	| QueryEngineService
	| RailwayMetricsService
	| RecommendationIssueService
	| RepoSandboxService
	| RuntimeAdvisoryCatalog
	| RuntimeReleaseCatalog
	| ScrapeTargetsService
	| SecurityAuditStore
	| SetupAuditService
	| StatusPageSnapshotBuilder
	| StatusPagesService
	| OrganizationFeatureFlagsService
	| UptimeMonitorsService
	| IngestRuleService
	| VcsCommitService
	| VcsSourceService
	| WarehouseQueryService

/** Every service a raw registered MCP handler may require. */
export type McpToolRequirements = CurrentMcpTenant | McpToolRuntimeRequirements
