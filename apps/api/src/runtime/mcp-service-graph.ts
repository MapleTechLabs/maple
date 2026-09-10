import { BucketCacheService } from "@maple/query-engine/caching"
import { Layer } from "effect"
import { McpToolExecutor } from "@/mcp/dispatcher"
import { EdgeCacheServiceLive } from "@/platform/CacheBackendLive"
import { AuditLogLive, OrgClickHouseSettingsLive, WarehouseLive } from "./warehouse-layer"
import { VcsSourceServiceLayer } from "./vcs-source-layer"
import { SandboxClient } from "@/sandbox/client"
import { CloudflareRepoSandboxLive } from "@/services/sandbox/CloudflareRepoSandbox"
import { RepoSandboxService } from "@/services/sandbox/RepoSandboxService"
import { EmailService } from "@/platform/EmailService"
import { Env } from "@/platform/Env"
import { AlertRuntime, AlertsService } from "@/services/alerts/AlertsService"
import { AlertDestinationsService } from "@/services/alerts/AlertDestinationsService"
import { AlertReadModelsService } from "@/services/alerts/AlertReadModelsService"
import { AlertRulesService } from "@/services/alerts/AlertRulesService"
import { NotificationDispatcher } from "@/services/alerts/NotificationDispatcher"
import { HazelOAuthService } from "@/services/auth/HazelOAuthService"
import { DashboardPersistenceService } from "@/services/dashboards/DashboardPersistenceService"
import { ErrorActorsService } from "@/services/errors/ErrorActorsService"
import { ErrorIssueReadModelsService } from "@/services/errors/ErrorIssueReadModelsService"
import { ErrorIssueWorkflowService } from "@/services/errors/ErrorIssueWorkflowService"
import { ErrorPolicyService } from "@/services/errors/ErrorPolicyService"
import { ErrorsService } from "@/services/errors/ErrorsService"
import { IssueFixVerificationService } from "@/services/errors/IssueFixVerificationService"
import { InvestigationService } from "@/services/errors/InvestigationService"
import { RecommendationIssueService } from "@/services/errors/RecommendationIssueService"
import { VcsRepository } from "@/services/integrations/vcs/VcsRepository"
import { PullRequestLookupLive } from "@/services/errors/pull-request-lookup-live"
import { OrgMembersService } from "@/services/org/OrgMembersService"
import { SetupAuditService } from "@/services/org/SetupAuditService"
import { QueryEngineService } from "@/services/warehouse/QueryEngineService"

const InfraLive = Env.layer

// MCP handlers use a finite service context (see runtime-requirements.ts).
// Keep this graph independent from the HTTP composition root so headless
// entrypoints do not evaluate or acquire route-only product services.
const OrgClickHouseSettingsServiceLive = OrgClickHouseSettingsLive.pipe(Layer.provide(InfraLive))
const HazelOAuthServiceLive = HazelOAuthService.layer.pipe(Layer.provide(InfraLive))
const WarehouseQueryServiceLive = WarehouseLive.pipe(Layer.provide(InfraLive))
const AuditLogServiceLive = AuditLogLive.pipe(Layer.provide(InfraLive))

const BucketCacheServiceLive = BucketCacheService.layer.pipe(Layer.provideMerge(EdgeCacheServiceLive))

const QueryEngineServiceLive = QueryEngineService.layer.pipe(
	Layer.provide(Layer.mergeAll(WarehouseQueryServiceLive, EdgeCacheServiceLive, BucketCacheServiceLive)),
)

const EmailServiceLive = EmailService.layer.pipe(Layer.provide(InfraLive))
const OrgMembersServiceLive = OrgMembersService.layer.pipe(Layer.provide(InfraLive))
const AlertRuntimeLive = AlertRuntime.layer

const AlertDestinationsServiceLive = AlertDestinationsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			AlertRuntimeLive,
			HazelOAuthServiceLive,
			EmailServiceLive,
			OrgMembersServiceLive,
		),
	),
)

const AlertReadModelsServiceLive = AlertReadModelsService.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, WarehouseQueryServiceLive)),
)

const AlertRulesServiceLive = AlertRulesService.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, AlertRuntimeLive)),
)

const AlertsServiceLive = AlertsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			QueryEngineServiceLive,
			WarehouseQueryServiceLive,
			AlertRuntimeLive,
			HazelOAuthServiceLive,
			EmailServiceLive,
			OrgMembersServiceLive,
			OrgClickHouseSettingsServiceLive,
			AlertDestinationsServiceLive,
			AlertReadModelsServiceLive,
			AlertRulesServiceLive,
		),
	),
)

const NotificationDispatcherLive = NotificationDispatcher.layer.pipe(
	Layer.provide(Layer.mergeAll(InfraLive, EmailServiceLive)),
)

const ErrorActorsServiceLive = ErrorActorsService.layer
const ErrorIssueWorkflowServiceLive = ErrorIssueWorkflowService.layer.pipe(
	Layer.provide(Layer.mergeAll(ErrorActorsServiceLive, AuditLogServiceLive)),
)
const ErrorPolicyServiceLive = ErrorPolicyService.layer
const ErrorIssueReadModelsServiceLive = ErrorIssueReadModelsService.layer.pipe(
	Layer.provide(Layer.mergeAll(WarehouseQueryServiceLive, ErrorIssueWorkflowServiceLive)),
)

const VcsSourceServiceLive = VcsSourceServiceLayer.pipe(Layer.provide(InfraLive))

// The agents' repository sandbox: effect-agent's `Sandbox` port over the sandbox
// Worker's service binding, which the client reads off `WorkerEnvironment`.
const SandboxClientLive = SandboxClient.layer.pipe(Layer.provide(InfraLive))
const RepoSandboxServiceLive = RepoSandboxService.layer.pipe(
	Layer.provide(
		CloudflareRepoSandboxLive.pipe(
			Layer.provide(Layer.mergeAll(VcsSourceServiceLive, SandboxClientLive)),
		),
	),
)

// Lets `propose_fix` and `link_pull_request` attach a PR with its real title
// and state, and open a verification window for one that already merged.
const PullRequestLookupServiceLive = PullRequestLookupLive.pipe(Layer.provide(VcsSourceServiceLive))

const IssueFixVerificationServiceLive = IssueFixVerificationService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			ErrorActorsServiceLive,
			ErrorIssueWorkflowServiceLive,
			PullRequestLookupServiceLive,
		),
	),
)

const ErrorsServiceLive = ErrorsService.layer.pipe(
	Layer.provide(
		Layer.mergeAll(
			InfraLive,
			WarehouseQueryServiceLive,
			EdgeCacheServiceLive,
			NotificationDispatcherLive,
			ErrorActorsServiceLive,
			ErrorIssueWorkflowServiceLive,
			ErrorPolicyServiceLive,
			// Lets `propose_fix` turn its `pr_url` into a durable link. Optional in
			// the service, so an graph that omits it still works — but this is the
			// agent's primary path, so it is wired here deliberately.
			IssueFixVerificationServiceLive,
		),
	),
)

const RecommendationIssueServiceLive = RecommendationIssueService.layer.pipe(
	Layer.provide(WarehouseQueryServiceLive),
)

const SetupAuditServiceLive = SetupAuditService.layer.pipe(Layer.provide(WarehouseQueryServiceLive))

const McpRuntimeServicesLive = Layer.mergeAll(
	AlertReadModelsServiceLive,
	AlertRulesServiceLive,
	AlertsServiceLive,
	AuditLogServiceLive,
	DashboardPersistenceService.layer,
	ErrorActorsServiceLive,
	ErrorIssueReadModelsServiceLive,
	ErrorIssueWorkflowServiceLive,
	ErrorPolicyServiceLive,
	ErrorsServiceLive,
	IssueFixVerificationServiceLive,
	QueryEngineServiceLive,
	RecommendationIssueServiceLive,
	RepoSandboxServiceLive,
	SetupAuditServiceLive,
	VcsSourceServiceLive,
	WarehouseQueryServiceLive,
)

/** MCP execution root used by headless fanout agents and direct tool evals. */
export const McpServicesLive = McpToolExecutor.layer.pipe(Layer.provide(McpRuntimeServicesLive))

const InvestigationServiceLive = InvestigationService.layer.pipe(Layer.provide(InfraLive))

/** MCP execution plus diagnosis persistence for chat turns and internal RPC. */
export const InvestigationServicesLive = Layer.mergeAll(McpServicesLive, InvestigationServiceLive)
