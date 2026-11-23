// BOUNDARY-FILE: This module owns unparsed external values and narrows them before domain use.
/**
 * The whole registry, every tool defined up front: the catalog chat, permissions, evals and tests
 * read. A public `tools/call` loads one tool instead (`tool-modules.generated.ts`, `tool-lookup.ts`).
 */
import type { McpToolSurface } from "@maple/domain/mcp-manifest"
import { Effect, Result, Schema, Array as Arr } from "effect"
import { registerAddDashboardWidgetTool } from "./add-dashboard-widget"
import { registerDescribeWarehouseTablesTool } from "./describe-warehouse-tables"
import { registerComparePeriodsTool } from "./compare-periods"
import { registerCompareOperationsTool } from "./compare-operations"
import { registerCreateAlertRuleTool } from "./create-alert-rule"
import { registerPreviewAlertRuleTool } from "./preview-alert-rule"
import { registerUpdateAlertRuleTool } from "./update-alert-rule"
import { registerDeleteAlertRuleTool } from "./delete-alert-rule"
import { registerListMaintenanceWindowsTool } from "./list-maintenance-windows"
import { registerListAlertSilencesTool } from "./list-alert-silences"
import { registerMaintenanceWindowTools } from "./manage-maintenance-window"
import { registerAlertSilenceTools } from "./manage-alert-silence"
import { registerEscalationChainTools } from "./manage-escalation-chain"
import { registerOnCallScheduleTools } from "./manage-oncall-schedule"
import { registerAcknowledgeAlertIncidentTool } from "./acknowledge-alert-incident"
import { registerListEscalationChainsTool } from "./list-escalation-chains"
import { registerListOnCallSchedulesTool } from "./list-oncall-schedules"
import { registerWhoIsOnCallTool } from "./who-is-on-call"
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
import { registerOnboardingTools } from "./onboarding"
import { registerListIntegrationsTool } from "./list-integrations"
import { registerListSecurityFindingsTool } from "./list-security-findings"
import { registerInspectSecurityFindingTool } from "./inspect-security-finding"
import { registerListSecurityAuditRunsTool } from "./list-security-audit-runs"
import { registerInspectSecurityAuditRunTool } from "./inspect-security-audit-run"
import { registerListSourcesTool } from "./list-sources"
import { registerListDataSourcesTool } from "./list-data-sources"
import { registerQueryDataSourceTool } from "./query-data-source"
import { canonicalToolCall, canonicalToolName } from "./tool-name-aliases"
import { registerCiRunsTool } from "./ci-runs"
import { registerCompareCommitsTool } from "./compare-commits"
import { registerIntegrationWriteTools } from "./integration-writes"
import { registerIngestSourceTools } from "./ingest-sources"
import { registerDeleteDashboardTool } from "./delete-dashboard"
import { registerAlertDestinationTools } from "./alert-destinations"
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
import { registerQueryCohortTool } from "./query-cohort"
import { registerQueryFunnelTool } from "./query-funnel"
import { registerQueryPathsTool } from "./query-paths"
import { registerQueryRetentionTool } from "./query-retention"
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
	resolveToolCall,
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
	registerQueryCohortTool,
	registerQueryFunnelTool,
	registerQueryPathsTool,
	registerQueryRetentionTool,
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
	registerAlertDestinationTools,
	registerGetAlertRuleTool,
	registerListAlertIncidentsTool,
	registerListAlertChecksTool,
	registerPreviewAlertRuleTool,
	registerGetIncidentTimelineTool,
	registerCreateAlertRuleTool,
	registerUpdateAlertRuleTool,
	registerDeleteAlertRuleTool,
	registerListMaintenanceWindowsTool,
	registerMaintenanceWindowTools,
	registerListAlertSilencesTool,
	registerAlertSilenceTools,
	registerAcknowledgeAlertIncidentTool,
	registerListEscalationChainsTool,
	registerEscalationChainTools,
	registerListOnCallSchedulesTool,
	registerWhoIsOnCallTool,
	registerOnCallScheduleTools,
	registerDescribeDashboardSchemaTool,
	registerListDashboardsTool,
	registerGetDashboardTool,
	registerCreateDashboardTool,
	registerUpdateDashboardTool,
	registerDeleteDashboardTool,
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
	registerOnboardingTools,
	registerListIntegrationsTool,
	registerSearchConsoleQueriesTool,
	registerSearchConsolePagesTool,
	registerListSecurityFindingsTool,
	registerInspectSecurityFindingTool,
	registerListSecurityAuditRunsTool,
	registerInspectSecurityAuditRunTool,
	registerListSourcesTool,
	registerIngestSourceTools,
	registerListDataSourcesTool,
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

/** Every entry a call is decoded as: each tool, and a family's actions in the family's place. */
export const mapleCallEntries: ReadonlyArray<MapleToolCatalogEntry> = Arr.flatMap(
	mapleToolCatalog,
	(entry) => entry.actions ?? [entry],
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
			/** The family action the call resolved to; `args` are that action's alone. */
			readonly action?: string
			readonly unknown: ReadonlyArray<string>
			readonly decodes: boolean
	  }
	| undefined => {
	const call = canonicalToolCall(name, input ?? {})
	const found = findDefinition(call.name)
	if (found === undefined) return undefined
	const resolved = resolveToolCall(found, call.input)
	// A family call that names no action it has reads as its bare arguments, none of which decode.
	if (Result.isFailure(resolved)) {
		return { args: isArgumentRecord(call.input) ? call.input : {}, unknown: [], decodes: false }
	}
	const { target: definition, input: args } = resolved.success
	const normalized = normalizeFor(definition, args)
	return {
		args: isArgumentRecord(normalized.args) ? normalized.args : {},
		...("action" in definition ? { action: definition.action } : undefined),
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
