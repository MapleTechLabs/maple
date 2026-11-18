// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * The whole registry, every tool defined up front: the catalog chat, permissions, evals and tests
 * read. A public `tools/call` loads one tool instead (`tool-modules.generated.ts`, `tool-lookup.ts`).
 */
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { Effect, Schema, Array as Arr } from "effect"
import { registerAddDashboardWidgetTool } from "./add-dashboard-widget"
import { registerDescribeWarehouseTablesTool } from "./describe-warehouse-tables"
import { registerComparePeriodsTool } from "./compare-periods"
import { registerCompareOperationsTool } from "./compare-operations"
import { registerCreateAlertRuleTool } from "./create-alert-rule"
import { registerPreviewAlertRuleTool } from "./preview-alert-rule"
import { registerUpdateAlertRuleTool } from "./update-alert-rule"
import { registerDeleteAlertRuleTool } from "./delete-alert-rule"
import { registerListMaintenanceWindowsTool } from "./list-maintenance-windows"
import { registerCreateMaintenanceWindowTool } from "./create-maintenance-window"
import { registerDeleteMaintenanceWindowTool } from "./delete-maintenance-window"
import { registerListAlertSilencesTool } from "./list-alert-silences"
import { registerCreateAlertSilenceTool } from "./create-alert-silence"
import { registerEndAlertSilenceTool } from "./end-alert-silence"
import { registerAcknowledgeAlertIncidentTool } from "./acknowledge-alert-incident"
import { registerListEscalationChainsTool } from "./list-escalation-chains"
import { registerCreateEscalationChainTool } from "./create-escalation-chain"
import { registerUpdateEscalationChainTool } from "./update-escalation-chain"
import { registerDeleteEscalationChainTool } from "./delete-escalation-chain"
import { registerListOnCallSchedulesTool } from "./list-oncall-schedules"
import { registerWhoIsOnCallTool } from "./who-is-on-call"
import { registerCreateOnCallScheduleTool } from "./create-oncall-schedule"
import { registerUpdateOnCallScheduleTool } from "./update-oncall-schedule"
import { registerDeleteOnCallScheduleTool } from "./delete-oncall-schedule"
import { registerCreateOnCallOverrideTool } from "./create-oncall-override"
import { registerDeleteOnCallOverrideTool } from "./delete-oncall-override"
import { registerCreateDashboardTool } from "./create-dashboard"
import { registerDescribeDashboardSchemaTool } from "./describe-dashboard-schema"
import { registerDiagnoseServiceTool } from "./diagnose-service"
import { registerErrorDetailTool } from "./error-detail"
import { registerExploreAttributesTool } from "./explore-attributes"
import { registerFindErrorsTool } from "./find-errors"
import { registerFindSlowTracesTool } from "./find-slow-traces"
import { registerGetAlertRuleTool } from "./get-alert-rule"
import { registerGetDashboardTool } from "./get-dashboard"
import { registerGetIncidentTimelineTool } from "./get-incident-timeline"
import { registerAuditSetupTool } from "./audit-setup"
import { registerListIntegrationsTool } from "./list-integrations"
import { registerListSecurityFindingsTool } from "./list-security-findings"
import { registerInspectSecurityFindingTool } from "./inspect-security-finding"
import { registerListSecurityAuditRunsTool } from "./list-security-audit-runs"
import { registerInspectSecurityAuditRunTool } from "./inspect-security-audit-run"
import { registerListSourcesTool } from "./list-sources"
import { registerListDataSourcesTool } from "./list-data-sources"
import { registerSearchDataSourcesTool } from "./search-data-sources"
import { registerDescribeDataSourceTool } from "./describe-data-source"
import { registerQueryDataSourceTool } from "./query-data-source"
import { canonicalToolName } from "./tool-name-aliases"
import { registerCiRunsTool } from "./ci-runs"
import { registerCompareCommitsTool } from "./compare-commits"
import { registerIntegrationWriteTools } from "./integration-writes"
import { registerUptimeMonitorTools } from "./uptime-monitors"
import { registerSloTools } from "./slos"
import { registerIngestRuleTools } from "./ingest-rules"
import { registerStatusPageTools } from "./status-pages"
import { registerGetInstrumentationRecommendationsTool } from "./get-instrumentation-recommendations"
import { registerGetServiceTopOperationsTool } from "./get-service-top-operations"
import { registerProfileHotspotsTool } from "./profile-hotspots"
import { registerServiceDeploymentsTool } from "./service-deployments"
import { registerRouteUsageTool } from "./route-usage"
import { registerSearchConsoleQueriesTool } from "./search-console-queries"
import { registerSearchConsolePagesTool } from "./search-console-pages"
import { registerIngestFreshnessTool } from "./ingest-freshness"
import { registerDbQueryVolumeTool } from "./db-query-volume"
import { registerListInfraTool } from "./list-infra"
import { registerInspectInfraTool } from "./inspect-infra"
import { registerIngestUsageTool } from "./ingest-usage"
import { registerInspectChartDataTool } from "./inspect-chart-data"
import { registerInspectTraceTool } from "./inspect-trace"
import { registerInspectSpanTool } from "./inspect-span"
import { registerListAlertChecksTool } from "./list-alert-checks"
import { registerListAlertIncidentsTool } from "./list-alert-incidents"
import { registerListAlertRulesTool } from "./list-alert-rules"
import { registerListAlertDestinationsTool } from "./list-alert-destinations"
import { registerClaimErrorIssueTool } from "./claim-error-issue"
import { registerCommentOnErrorIssueTool } from "./comment-on-error-issue"
import { registerListErrorIncidentsTool } from "./list-error-incidents"
import { registerListErrorIssueEventsTool } from "./list-error-issue-events"
import { registerGetInvestigationTool } from "./get-investigation"
import { registerListErrorIssuesTool } from "./list-error-issues"
import { registerLinkPullRequestTool } from "./link-pull-request"
import { registerProposeFixTool } from "./propose-fix"
import { registerRegisterAgentTool } from "./register-agent"
import { registerSendMapleFeedbackTool } from "./send-maple-feedback"
import { registerListMapleFeedbackTool } from "./list-maple-feedback"
import { registerReleaseErrorIssueTool } from "./release-error-issue"
import { registerSetIssueSeverityTool } from "./set-issue-severity"
import { registerMergeErrorIssuesTool } from "./merge-error-issues"
import { registerTransitionErrorIssueTool } from "./transition-error-issue"
import { registerTransitionErrorIssuesTool } from "./transition-error-issues"
import { registerUpdateErrorNotificationPolicyTool } from "./update-error-notification-policy"
import { registerGetErrorNotificationPolicyTool } from "./get-error-notification-policy"
import { registerListDashboardsTool } from "./list-dashboards"
import { registerListMetricsTool } from "./list-metrics"
import { registerListServicesTool } from "./list-services"
import { registerQueryDataTool } from "./query-data"
import { registerQueryPromqlTool } from "./query-promql"
import { registerRunSqlTool } from "./run-sql"
import { registerRemoveDashboardWidgetTool } from "./remove-dashboard-widget"
import { registerReplaceDashboardWidgetsTool } from "./replace-dashboard-widgets"
import { registerReorderDashboardWidgetsTool } from "./reorder-dashboard-widgets"
import { registerMineLogPatternsTool } from "./mine-log-patterns"
import { registerCompareLogPatternsTool } from "./compare-log-patterns"
import { registerSearchLogsTool } from "./search-logs"
import { registerSearchTracesTool } from "./search-traces"
import { registerSearchSessionsTool } from "./search-sessions"
import { registerQueryFunnelTool } from "./query-funnel"
import { registerListProductEventsTool } from "./list-product-events"
import { registerGetSessionTranscriptTool } from "./get-session-transcript"
import { registerGetSessionTracesTool } from "./get-session-traces"
import { registerListAgentSessionsTool } from "./list-agent-sessions"
import { registerListUsersTool } from "./list-users"
import { registerInspectUserTool } from "./inspect-user"
import { registerGetAgentSessionTool } from "./get-agent-session"
import { registerGetAgentSessionTranscriptTool } from "./get-agent-session-transcript"
import { registerGetAgentToolsOverviewTool } from "./get-agent-tools-overview"
import { registerGetAgentToolErrorTool } from "./get-agent-tool-error"
import { registerServiceMapTool } from "./service-map"
import { registerSourceCodeTools } from "./source-code"
import { registerSandboxTools } from "./sandbox"
import { registerPullRequestTools } from "./pull-request"
import { registerUpdateDashboardTool } from "./update-dashboard"
import { registerUpdateDashboardWidgetTool } from "./update-dashboard-widget"
import { surfaceAdmits } from "./types"
import {
	collectToolDefinitions,
	executeRegisteredTool,
	isArgumentRecord,
	type MapleToolCatalogEntry,
	type MapleToolDefinition,
	type McpToolLookup,
	type McpToolRegister,
	normalizeFor,
} from "./registry-core"

export { inputSchemaOf, type MapleToolCatalogEntry, toInputSchema, toOutputSchema } from "./registry-core"

/** Every tool's registration function, in catalog order (the order `tools/list` publishes). */
const MAPLE_TOOL_REGISTERS: ReadonlyArray<McpToolRegister> = [
	registerFindErrorsTool,
	registerInspectTraceTool,
	registerInspectSpanTool,
	registerSearchLogsTool,
	registerMineLogPatternsTool,
	registerCompareLogPatternsTool,
	registerSearchTracesTool,
	registerSearchSessionsTool,
	registerQueryFunnelTool,
	registerListProductEventsTool,
	registerGetSessionTranscriptTool,
	registerGetSessionTracesTool,
	registerListUsersTool,
	registerInspectUserTool,
	registerListAgentSessionsTool,
	registerGetAgentSessionTool,
	registerGetAgentSessionTranscriptTool,
	registerGetAgentToolsOverviewTool,
	registerGetAgentToolErrorTool,
	registerDiagnoseServiceTool,
	registerFindSlowTracesTool,
	registerErrorDetailTool,
	registerListMetricsTool,
	registerQueryDataTool,
	registerQueryPromqlTool,
	registerRunSqlTool,
	registerServiceMapTool,
	registerListAlertRulesTool,
	registerListAlertDestinationsTool,
	registerGetAlertRuleTool,
	registerListAlertIncidentsTool,
	registerListAlertChecksTool,
	registerPreviewAlertRuleTool,
	registerGetIncidentTimelineTool,
	registerCreateAlertRuleTool,
	registerUpdateAlertRuleTool,
	registerDeleteAlertRuleTool,
	registerListMaintenanceWindowsTool,
	registerCreateMaintenanceWindowTool,
	registerDeleteMaintenanceWindowTool,
	registerListAlertSilencesTool,
	registerCreateAlertSilenceTool,
	registerEndAlertSilenceTool,
	registerAcknowledgeAlertIncidentTool,
	registerListEscalationChainsTool,
	registerCreateEscalationChainTool,
	registerUpdateEscalationChainTool,
	registerDeleteEscalationChainTool,
	registerListOnCallSchedulesTool,
	registerWhoIsOnCallTool,
	registerCreateOnCallScheduleTool,
	registerUpdateOnCallScheduleTool,
	registerDeleteOnCallScheduleTool,
	registerCreateOnCallOverrideTool,
	registerDeleteOnCallOverrideTool,
	registerDescribeDashboardSchemaTool,
	registerListDashboardsTool,
	registerGetDashboardTool,
	registerCreateDashboardTool,
	registerUpdateDashboardTool,
	registerAddDashboardWidgetTool,
	registerDescribeWarehouseTablesTool,
	registerUpdateDashboardWidgetTool,
	registerRemoveDashboardWidgetTool,
	registerReplaceDashboardWidgetsTool,
	registerReorderDashboardWidgetsTool,
	registerInspectChartDataTool,
	registerComparePeriodsTool,
	registerCompareOperationsTool,
	registerExploreAttributesTool,
	registerListServicesTool,
	registerGetServiceTopOperationsTool,
	registerProfileHotspotsTool,
	registerServiceDeploymentsTool,
	registerRouteUsageTool,
	registerIngestFreshnessTool,
	registerDbQueryVolumeTool,
	registerListInfraTool,
	registerInspectInfraTool,
	registerIngestUsageTool,
	registerGetInstrumentationRecommendationsTool,
	registerAuditSetupTool,
	registerListIntegrationsTool,
	registerSearchConsoleQueriesTool,
	registerSearchConsolePagesTool,
	registerListSecurityFindingsTool,
	registerInspectSecurityFindingTool,
	registerListSecurityAuditRunsTool,
	registerInspectSecurityAuditRunTool,
	registerListSourcesTool,
	registerListDataSourcesTool,
	registerSearchDataSourcesTool,
	registerDescribeDataSourceTool,
	registerQueryDataSourceTool,
	registerCiRunsTool,
	registerCompareCommitsTool,
	registerIntegrationWriteTools,
	registerUptimeMonitorTools,
	registerSloTools,
	registerIngestRuleTools,
	registerStatusPageTools,
	registerSourceCodeTools,
	registerSandboxTools,
	registerPullRequestTools,
	registerListErrorIssuesTool,
	registerTransitionErrorIssueTool,
	registerTransitionErrorIssuesTool,
	registerSetIssueSeverityTool,
	registerMergeErrorIssuesTool,
	registerClaimErrorIssueTool,
	registerReleaseErrorIssueTool,
	registerCommentOnErrorIssueTool,
	registerProposeFixTool,
	registerLinkPullRequestTool,
	registerListErrorIssueEventsTool,
	registerGetInvestigationTool,
	registerRegisterAgentTool,
	registerSendMapleFeedbackTool,
	registerListMapleFeedbackTool,
	registerListErrorIncidentsTool,
	registerGetErrorNotificationPolicyTool,
	registerUpdateErrorNotificationPolicyTool,
]

const mapleToolDefinitions = collectToolDefinitions(MAPLE_TOOL_REGISTERS)

/** Handler-free registry view for schemas, permissions, MCP discovery, and tests. */
export const mapleToolCatalog: ReadonlyArray<MapleToolCatalogEntry> = Arr.map(
	mapleToolDefinitions,
	({ run: _run, ...entry }) => entry,
)

const findDefinition = (name: string): MapleToolDefinition | undefined => {
	const canonical = canonicalToolName(name)
	return mapleToolDefinitions.find((candidate) => candidate.name === canonical)
}

/**
 * A call read the way the dispatcher reads it, without running it: aliases applied, enum case
 * fixed, unknown keys reported, and whether the result decodes. Undefined for a name the registry
 * does not have. Evals score what a call means through this, never its raw spelling.
 */
export const readToolCall = (
	name: string,
	input: unknown,
):
	| {
			readonly args: Readonly<Record<string, unknown>>
			readonly unknown: ReadonlyArray<string>
			readonly decodes: boolean
	  }
	| undefined => {
	const definition = findDefinition(name)
	if (definition === undefined) return undefined
	const normalized = normalizeFor(definition, input ?? {})
	return {
		args: isArgumentRecord(normalized.args) ? normalized.args : {},
		unknown: Arr.map(normalized.unknown, (entry) => entry.key),
		decodes:
			Schema.decodeUnknownOption(definition.schema)(normalized.args, definition.parseOptions)._tag ===
			"Some",
	}
}

const titlesByName = new Map(Arr.map(mapleToolDefinitions, ({ name, title }) => [name, title]))

/** A tool's human title ("Search Repository Checkout"), or undefined for a name outside the registry. */
export const mapleToolTitle = (name: string): string | undefined => titlesByName.get(name)

const phrasesByName = new Map(Arr.map(mapleToolDefinitions, ({ name, phrases }) => [name, phrases]))

/**
 * One of a tool's {@link McpToolPhrases}, at random, or undefined for a name outside the
 * registry. Picked once, when the call is declared: the event log keeps it, so every re-render of
 * the same call shows the same words.
 */
export const mapleToolPhrase = (name: string): string | undefined => {
	const phrases = phrasesByName.get(name)
	return phrases?.[Math.floor(Math.random() * phrases.length)]
}

/** The catalog as one surface sees it. What a surface cannot see, it cannot call either. */
export const mapleToolCatalogFor = (surface: McpToolSurface): ReadonlyArray<MapleToolCatalogEntry> =>
	Arr.filter(mapleToolCatalog, (definition) => surfaceAdmits(definition, surface))

/** The whole registry as a lookup, for callers that already hold it. */
const registryLookup: McpToolLookup = {
	find: (name) => Effect.sync(() => findDefinition(name)),
	namesFor: (surface) => Arr.map(mapleToolCatalogFor(surface), (entry) => entry.name),
}

/** {@link executeRegisteredTool} over the whole registry. Only `McpToolExecutor` closes its environment. */
export const executeRegisteredMcpToolUnscoped = (name: string, input: unknown, surface: McpToolSurface) =>
	executeRegisteredTool(registryLookup, name, input, surface)
