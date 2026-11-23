/**
 * Every MCP tool's output schema, by tool name: the one list both the registry (which checks
 * each tool declares exactly this schema) and the chat UI's `StructuredToolOutput` derive from.
 */
import { familyOutput } from "./shared"
import { ListMapleFeedbackOutput, SendMapleFeedbackOutput } from "./feedback"
import { InspectInfraOutput, ListInfraOutput } from "./infra"
import { DeleteSourceOutput, ListSourcesOutput, SourceMutationOutput } from "./sources"
import { ListDataSourcesOutput, QueryDataSourceOutput } from "./data-sources"
import { GetEvaluationScoresOutput, ListEvaluationsOutput } from "./evaluations"
import { SearchConsolePagesOutput, SearchConsoleQueriesOutput } from "./search-console"
import { InspectUserOutput, ListUsersOutput } from "./users"
import {
	InspectSecurityAuditRunOutput,
	InspectSecurityFindingOutput,
	ListSecurityAuditRunsOutput,
	ListSecurityFindingsOutput,
} from "./security"
import { DeleteUptimeMonitorOutput, ListUptimeMonitorsOutput, UptimeMonitorMutationOutput } from "./uptime"
import { DeleteSloOutput, InspectSloOutput, ListSlosOutput, SloMutationOutput } from "./slo"
import {
	ApplyStatusPageConfigOutput,
	CreateStatusPageOutput,
	GetStatusPageOutput,
	PublishStatusPageOutput,
	SetStatusPageDomainOutput,
	StatusPageIncidentMutationOutput,
} from "./status-pages"
import {
	DeleteIngestRuleOutput,
	IngestRuleMutationOutput,
	ListIngestRulesOutput,
	PreviewIngestRuleOutput,
} from "./ingest-rules"
import {
	DeleteScrapeTargetOutput,
	ListIntegrationsOutput,
	ScrapeTargetMutationOutput,
	SyncRailwayOutput,
	SyncVercelOutput,
} from "./integrations"
import { CiRunsOutput, CompareCommitsOutput } from "./ci"
import { AlertSilenceMutationOutput, ListAlertSilencesOutput } from "./alert-silences"
import {
	DeleteMaintenanceWindowOutput,
	ListMaintenanceWindowsOutput,
	MaintenanceWindowMutationOutput,
} from "./maintenance-windows"
import {
	AcknowledgeAlertIncidentOutput,
	CreateAlertRuleOutput,
	DeleteAlertRuleOutput,
	GetAlertRuleOutput,
	GetIncidentTimelineOutput,
	ListAlertChecksOutput,
	PreviewAlertRuleOutput,
	ListAlertDestinationsOutput,
	ListAlertIncidentsOutput,
	ListAlertRulesOutput,
	UpdateAlertRuleOutput,
	AlertDestinationMutationOutput,
	DeleteAlertDestinationOutput,
	TestAlertDestinationOutput,
} from "./alerts"
import {
	DeleteEscalationChainOutput,
	EscalationChainMutationOutput,
	ListEscalationChainsOutput,
} from "./escalation-chains"
import {
	DeleteOnCallOverrideOutput,
	DeleteOnCallScheduleOutput,
	ListOnCallSchedulesOutput,
	OnCallOverrideMutationOutput,
	OnCallScheduleMutationOutput,
	WhoIsOnCallOutput,
} from "./oncall-schedules"
import {
	AddDashboardWidgetOutput,
	CreateDashboardOutput,
	DescribeDashboardSchemaOutput,
	GetDashboardOutput,
	InspectChartDataOutput,
	ListDashboardsOutput,
	RemoveDashboardWidgetOutput,
	ReorderDashboardWidgetsOutput,
	ReplaceDashboardWidgetsOutput,
	UpdateDashboardOutput,
	UpdateDashboardWidgetOutput,
	DeleteDashboardOutput,
} from "./dashboards"
import { ErrorDetailOutput, FindErrorsOutput } from "./errors"
import { QueryPromqlOutput } from "./promql"
import { GetMetricExemplarsOutput } from "./metrics"
import { GetInvestigationOutput } from "./investigations"
import {
	ClaimErrorIssueOutput,
	CommentOnErrorIssueOutput,
	LinkPullRequestOutput,
	ListErrorIncidentsOutput,
	ListErrorIssueEventsOutput,
	ListErrorIssuesOutput,
	ProposeFixOutput,
	RegisterAgentOutput,
	ReleaseErrorIssueOutput,
	SetIssueSeverityOutput,
	MergeErrorIssuesOutput,
	TransitionErrorIssueOutput,
	TransitionErrorIssuesOutput,
	GetErrorNotificationPolicyOutput,
	UpdateErrorNotificationPolicyOutput,
} from "./issues"
import {
	CompareOperationsOutput,
	ComparePeriodsOutput,
	DescribeWarehouseTablesOutput,
	DiagnoseServiceOutput,
	ExploreAttributesOutput,
	GetServiceTopOperationsOutput,
	ListMetricsOutput,
	ListServicesOutput,
	QueryDataOutput,
	RunSqlOutput,
	ServiceMapOutput,
} from "./services"
import {
	GetAgentSessionOutput,
	GetAgentSessionTranscriptOutput,
	GetAgentToolErrorOutput,
	GetAgentToolsOverviewOutput,
	GetSessionTracesOutput,
	GetSessionTranscriptOutput,
	ListAgentSessionsOutput,
	ListProductEventsOutput,
	QueryCohortOutput,
	QueryFunnelOutput,
	QueryPathsOutput,
	QueryRetentionOutput,
	SearchSessionsOutput,
} from "./sessions"
import {
	AuditSetupOutput,
	GetInstrumentationRecommendationsOutput,
	ListSourceRepositoriesOutput,
	PrChangedFilesOutput,
	PrContextOutput,
	PrFileDiffOutput,
	ReadSourceFileOutput,
	SandboxExecOutput,
	SandboxGrepOutput,
	SandboxListFilesOutput,
	SandboxReadFileOutput,
	SearchSourceCodeOutput,
} from "./setup"
import {
	DbQueryVolumeOutput,
	IngestFreshnessOutput,
	IngestUsageOutput,
	RouteUsageOutput,
	ServiceDeploymentsOutput,
} from "./service-activity"
import { ProfileHotspotsOutput } from "./profiles"
import { GetIngestSetupOutput, OnboardingStatusUpdateOutput } from "./onboarding"
import {
	FindSlowTracesOutput,
	InspectSpanOutput,
	InspectTraceOutput,
	MineLogPatternsOutput,
	CompareLogPatternsOutput,
	SearchLogsOutput,
	SearchTracesOutput,
} from "./traces"

/**
 * The tools that are one resource's write actions under an `action` parameter, and what each action
 * returns. A family's output is `{ action, result }` (see {@link familyOutput}).
 */
export const McpToolFamilyActions = {
	manage_alert_destination: {
		create: AlertDestinationMutationOutput,
		update: AlertDestinationMutationOutput,
		delete: DeleteAlertDestinationOutput,
		test: TestAlertDestinationOutput,
	},
	manage_alert_silence: {
		create: AlertSilenceMutationOutput,
		end: AlertSilenceMutationOutput,
	},
	manage_escalation_chain: {
		create: EscalationChainMutationOutput,
		update: EscalationChainMutationOutput,
		delete: DeleteEscalationChainOutput,
	},
	manage_ingest_rule: {
		create: IngestRuleMutationOutput,
		update: IngestRuleMutationOutput,
		delete: DeleteIngestRuleOutput,
	},
	manage_ingest_source: {
		pause: SourceMutationOutput,
		resume: SourceMutationOutput,
		update: SourceMutationOutput,
		delete: DeleteSourceOutput,
	},
	manage_maintenance_window: {
		create: MaintenanceWindowMutationOutput,
		update: MaintenanceWindowMutationOutput,
		delete: DeleteMaintenanceWindowOutput,
	},
	manage_oncall_schedule: {
		create: OnCallScheduleMutationOutput,
		update: OnCallScheduleMutationOutput,
		delete: DeleteOnCallScheduleOutput,
		add_override: OnCallOverrideMutationOutput,
		remove_override: DeleteOnCallOverrideOutput,
	},
	manage_scrape_target: {
		create: ScrapeTargetMutationOutput,
		update: ScrapeTargetMutationOutput,
		delete: DeleteScrapeTargetOutput,
	},
	manage_slo: {
		create: SloMutationOutput,
		update: SloMutationOutput,
		delete: DeleteSloOutput,
	},
	manage_status_page: {
		create: CreateStatusPageOutput,
		apply_config: ApplyStatusPageConfigOutput,
		publish: PublishStatusPageOutput,
		set_domain: SetStatusPageDomainOutput,
		post_update: StatusPageIncidentMutationOutput,
	},
	manage_uptime_monitor: {
		create: UptimeMonitorMutationOutput,
		update: UptimeMonitorMutationOutput,
		delete: DeleteUptimeMonitorOutput,
	},
} as const

export type McpToolFamilyName = keyof typeof McpToolFamilyActions
export const McpToolOutputs = {
	add_dashboard_widget: AddDashboardWidgetOutput,
	audit_setup: AuditSetupOutput,
	ci_runs: CiRunsOutput,
	claim_error_issue: ClaimErrorIssueOutput,
	comment_on_error_issue: CommentOnErrorIssueOutput,
	compare_commits: CompareCommitsOutput,
	compare_periods: ComparePeriodsOutput,
	compare_log_patterns: CompareLogPatternsOutput,
	compare_operations: CompareOperationsOutput,
	create_alert_rule: CreateAlertRuleOutput,
	create_dashboard: CreateDashboardOutput,
	db_query_volume: DbQueryVolumeOutput,
	delete_alert_rule: DeleteAlertRuleOutput,
	delete_dashboard: DeleteDashboardOutput,
	acknowledge_alert_incident: AcknowledgeAlertIncidentOutput,
	describe_dashboard_schema: DescribeDashboardSchemaOutput,
	describe_warehouse_tables: DescribeWarehouseTablesOutput,
	diagnose_service: DiagnoseServiceOutput,
	error_detail: ErrorDetailOutput,
	explore_attributes: ExploreAttributesOutput,
	find_errors: FindErrorsOutput,
	find_slow_traces: FindSlowTracesOutput,
	get_agent_session: GetAgentSessionOutput,
	get_agent_session_transcript: GetAgentSessionTranscriptOutput,
	get_agent_tool_error: GetAgentToolErrorOutput,
	get_agent_tools_overview: GetAgentToolsOverviewOutput,
	get_alert_rule: GetAlertRuleOutput,
	get_dashboard: GetDashboardOutput,
	get_evaluation_scores: GetEvaluationScoresOutput,
	get_incident_timeline: GetIncidentTimelineOutput,
	get_ingest_setup: GetIngestSetupOutput,
	get_investigation: GetInvestigationOutput,
	get_metric_exemplars: GetMetricExemplarsOutput,
	get_instrumentation_recommendations: GetInstrumentationRecommendationsOutput,
	get_service_top_operations: GetServiceTopOperationsOutput,
	profile_hotspots: ProfileHotspotsOutput,
	get_session_traces: GetSessionTracesOutput,
	get_session_transcript: GetSessionTranscriptOutput,
	ingest_freshness: IngestFreshnessOutput,
	ingest_usage: IngestUsageOutput,
	inspect_chart_data: InspectChartDataOutput,
	inspect_infra: InspectInfraOutput,
	inspect_security_audit_run: InspectSecurityAuditRunOutput,
	inspect_security_finding: InspectSecurityFindingOutput,
	inspect_slo: InspectSloOutput,
	inspect_span: InspectSpanOutput,
	inspect_trace: InspectTraceOutput,
	inspect_user: InspectUserOutput,
	link_pull_request: LinkPullRequestOutput,
	list_agent_sessions: ListAgentSessionsOutput,
	list_alert_checks: ListAlertChecksOutput,
	list_evaluations: ListEvaluationsOutput,
	list_ingest_rules: ListIngestRulesOutput,
	preview_alert_rule: PreviewAlertRuleOutput,
	list_alert_destinations: ListAlertDestinationsOutput,
	list_alert_incidents: ListAlertIncidentsOutput,
	list_alert_rules: ListAlertRulesOutput,
	list_escalation_chains: ListEscalationChainsOutput,
	list_maintenance_windows: ListMaintenanceWindowsOutput,
	list_oncall_schedules: ListOnCallSchedulesOutput,
	list_alert_silences: ListAlertSilencesOutput,
	list_dashboards: ListDashboardsOutput,
	list_error_incidents: ListErrorIncidentsOutput,
	list_error_issue_events: ListErrorIssueEventsOutput,
	list_error_issues: ListErrorIssuesOutput,
	list_infra: ListInfraOutput,
	list_integrations: ListIntegrationsOutput,
	list_security_audit_runs: ListSecurityAuditRunsOutput,
	list_security_findings: ListSecurityFindingsOutput,
	list_slos: ListSlosOutput,
	list_ingest_sources: ListSourcesOutput,
	list_data_sources: ListDataSourcesOutput,
	query_data_source: QueryDataSourceOutput,
	list_uptime_monitors: ListUptimeMonitorsOutput,
	list_users: ListUsersOutput,
	get_status_page: GetStatusPageOutput,
	list_metrics: ListMetricsOutput,
	list_product_events: ListProductEventsOutput,
	list_services: ListServicesOutput,
	list_source_repositories: ListSourceRepositoriesOutput,
	mine_log_patterns: MineLogPatternsOutput,
	onboarding_status_update: OnboardingStatusUpdateOutput,
	pr_changed_files: PrChangedFilesOutput,
	pr_context: PrContextOutput,
	pr_file_diff: PrFileDiffOutput,
	preview_ingest_rule: PreviewIngestRuleOutput,
	propose_fix: ProposeFixOutput,
	query_data: QueryDataOutput,
	query_cohort: QueryCohortOutput,
	query_funnel: QueryFunnelOutput,
	query_paths: QueryPathsOutput,
	query_retention: QueryRetentionOutput,
	query_promql: QueryPromqlOutput,
	read_source_file: ReadSourceFileOutput,
	register_agent: RegisterAgentOutput,
	release_error_issue: ReleaseErrorIssueOutput,
	remove_dashboard_widget: RemoveDashboardWidgetOutput,
	reorder_dashboard_widgets: ReorderDashboardWidgetsOutput,
	replace_dashboard_widgets: ReplaceDashboardWidgetsOutput,
	route_usage: RouteUsageOutput,
	run_sql: RunSqlOutput,
	sandbox_exec: SandboxExecOutput,
	sandbox_grep: SandboxGrepOutput,
	sandbox_list_files: SandboxListFilesOutput,
	sandbox_read_file: SandboxReadFileOutput,
	search_console_pages: SearchConsolePagesOutput,
	search_console_queries: SearchConsoleQueriesOutput,
	search_logs: SearchLogsOutput,
	search_sessions: SearchSessionsOutput,
	search_source_code: SearchSourceCodeOutput,
	search_traces: SearchTracesOutput,
	send_maple_feedback: SendMapleFeedbackOutput,
	list_maple_feedback: ListMapleFeedbackOutput,
	service_deployments: ServiceDeploymentsOutput,
	service_map: ServiceMapOutput,
	sync_railway: SyncRailwayOutput,
	sync_vercel: SyncVercelOutput,
	set_issue_severity: SetIssueSeverityOutput,
	manage_alert_destination: familyOutput(McpToolFamilyActions.manage_alert_destination),
	manage_alert_silence: familyOutput(McpToolFamilyActions.manage_alert_silence),
	manage_escalation_chain: familyOutput(McpToolFamilyActions.manage_escalation_chain),
	manage_ingest_rule: familyOutput(McpToolFamilyActions.manage_ingest_rule),
	manage_ingest_source: familyOutput(McpToolFamilyActions.manage_ingest_source),
	manage_maintenance_window: familyOutput(McpToolFamilyActions.manage_maintenance_window),
	manage_oncall_schedule: familyOutput(McpToolFamilyActions.manage_oncall_schedule),
	manage_scrape_target: familyOutput(McpToolFamilyActions.manage_scrape_target),
	manage_slo: familyOutput(McpToolFamilyActions.manage_slo),
	manage_status_page: familyOutput(McpToolFamilyActions.manage_status_page),
	manage_uptime_monitor: familyOutput(McpToolFamilyActions.manage_uptime_monitor),
	merge_error_issues: MergeErrorIssuesOutput,
	transition_error_issue: TransitionErrorIssueOutput,
	transition_error_issues: TransitionErrorIssuesOutput,
	update_alert_rule: UpdateAlertRuleOutput,
	update_dashboard: UpdateDashboardOutput,
	update_dashboard_widget: UpdateDashboardWidgetOutput,
	get_error_notification_policy: GetErrorNotificationPolicyOutput,
	update_error_notification_policy: UpdateErrorNotificationPolicyOutput,
	who_is_on_call: WhoIsOnCallOutput,
} as const

export type McpToolName = keyof typeof McpToolOutputs
