import type { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
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
import type { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import type { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import type { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import type { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import type { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"
import type { CurrentMcpTenant } from "../lib/query-warehouse"

/**
 * Application services an MCP tool handler may use after its request tenant has
 * been supplied. This is intentionally finite: registering a tool with a new
 * dependency must also extend the executor layer that captures that dependency.
 */
export type McpToolRuntimeRequirements =
	| AlertsService
	| AuditLogService
	| AlertReadModelsService
	| AlertRulesService
	| DashboardPersistenceService
	| ErrorActorsService
	| ErrorIssueReadModelsService
	| ErrorIssueWorkflowService
	| ErrorPolicyService
	| ErrorsService
	| IssueFixVerificationService
	| QueryEngineService
	| RecommendationIssueService
	| RepoSandboxService
	| SetupAuditService
	| VcsSourceService
	| WarehouseQueryService

/** Every service a raw registered MCP handler may require. */
export type McpToolRequirements = CurrentMcpTenant | McpToolRuntimeRequirements
