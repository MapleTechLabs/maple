// Every MCP tool runtime service a test does not exercise: unimplemented mocks that die when
// used, plus the real layers of the three services whose sync members a mock cannot stub.
import { Layer } from "effect"
import { AuditLogService } from "@maple/backend/services/audit/AuditLogService"
import { AgentFeedbackService } from "@maple/backend/services/feedback/AgentFeedbackService"
import { AlertsService } from "@maple/backend/services/alerts/AlertsService"
import { AlertReadModelsService } from "@maple/backend/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@maple/backend/services/alerts/AlertRulesService"
import { DashboardPersistenceService } from "@maple/backend/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@maple/backend/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@maple/backend/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@maple/backend/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@maple/backend/services/errors/ErrorPolicyService"
import { ErrorsService } from "@maple/backend/services/errors/ErrorsService"
import { IssueFixVerificationService } from "@maple/backend/services/errors/IssueFixVerificationService"
import { RecommendationIssueService } from "@maple/backend/services/errors/RecommendationIssueService"
import { IntegrationInventoryService } from "@maple/backend/services/integrations/IntegrationInventoryService"
import { SourcesService } from "@maple/backend/services/org/SourcesService"
import { RailwayMetricsService } from "@maple/backend/services/integrations/RailwayMetricsService"
import { ScrapeTargetsService } from "@maple/backend/services/integrations/ScrapeTargetsService"
import { VcsCommitService } from "@maple/backend/services/integrations/vcs/VcsCommitService"
import { VcsSourceService } from "@maple/backend/services/integrations/vcs/VcsSourceService"
import { SetupAuditService } from "@maple/backend/services/org/SetupAuditService"
import { UptimeMonitorsService } from "@maple/backend/services/uptime/UptimeMonitorsService"
import { IngestRuleService } from "@maple/backend/services/org/IngestRuleService"
import { StatusPagesService } from "@maple/backend/services/status-pages/StatusPagesService"
import { StatusPageSnapshotBuilder } from "@maple/backend/services/status-pages/StatusPageSnapshotBuilder"
import { RepoSandboxService } from "@maple/backend/services/sandbox/RepoSandboxService"
import { QueryEngineService } from "@maple/backend/services/warehouse/QueryEngineService"
import { WarehouseQueryService } from "@maple/backend/services/warehouse/WarehouseQueryService"

export const unimplementedMcpToolServices = Layer.mergeAll(
	Layer.mock(AuditLogService)({}),
	Layer.mock(AgentFeedbackService)({}),
	Layer.mock(AlertsService)({}),
	Layer.mock(AlertReadModelsService)({}),
	Layer.mock(AlertRulesService)({}),
	Layer.mock(DashboardPersistenceService)({}),
	Layer.mock(ErrorActorsService)({}),
	Layer.mock(ErrorIssueReadModelsService)({}),
	ErrorIssueWorkflowService.layer,
	ErrorPolicyService.layer,
	Layer.mock(ErrorsService)({}),
	Layer.mock(IssueFixVerificationService)({}),
	Layer.mock(RecommendationIssueService)({}),
	Layer.mock(IntegrationInventoryService)({}),
	Layer.mock(SourcesService)({}),
	Layer.mock(RailwayMetricsService)({}),
	Layer.mock(ScrapeTargetsService)({}),
	Layer.mock(VcsCommitService)({}),
	Layer.mock(VcsSourceService)({}),
	Layer.mock(SetupAuditService)({}),
	Layer.mock(UptimeMonitorsService)({}),
	Layer.mock(IngestRuleService)({}),
	Layer.mock(StatusPagesService)({}),
	Layer.mock(StatusPageSnapshotBuilder)({}),
	Layer.mock(RepoSandboxService)({}),
	Layer.mock(QueryEngineService)({}),
	WarehouseQueryService.layer,
)
