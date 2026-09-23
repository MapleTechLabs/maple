/**
 * What a tool call is doing, in words a channel reads: `run_sql` is "Running a query".
 *
 * Several phrasings where one tool is called over and over in a turn, so a status line that edits
 * in place does not read as stuck on the same words. Every phrasing says only what the tool does —
 * never a guess at why, and never a result it has not produced yet.
 */

const PHRASES = new Map(
	Object.entries({
		// warehouse
		run_sql: ["Running a query", "Running SQL", "Querying the warehouse"],
		query_data: ["Querying telemetry", "Running a query", "Pulling the numbers"],
		describe_warehouse_tables: ["Reading table schemas", "Describing warehouse tables"],
		explore_attributes: ["Exploring attributes", "Looking up attribute values"],
		list_metrics: ["Listing metrics", "Looking up metrics"],
		inspect_chart_data: ["Inspecting chart data"],
		compare_periods: ["Comparing time periods", "Comparing against an earlier period"],
		// services
		list_services: ["Listing services", "Checking which services are reporting"],
		diagnose_service: ["Diagnosing a service", "Checking a service's health"],
		service_map: ["Loading the service map", "Mapping service dependencies"],
		get_service_top_operations: ["Finding top operations", "Ranking a service's operations"],
		get_instrumentation_recommendations: ["Checking instrumentation"],
		audit_setup: ["Auditing the setup", "Checking the telemetry setup"],
		// traces and logs
		search_traces: ["Searching traces", "Looking through traces"],
		find_slow_traces: ["Finding slow traces", "Looking for slow requests"],
		inspect_trace: ["Inspecting a trace", "Opening a trace"],
		inspect_span: ["Inspecting a span", "Reading span details"],
		search_logs: ["Searching logs", "Reading through logs"],
		mine_log_patterns: ["Grouping log patterns", "Finding common log patterns"],
		// errors
		find_errors: ["Looking for errors", "Finding errors"],
		error_detail: ["Reading error details", "Looking into an error"],
		list_error_issues: ["Listing error issues", "Checking open issues"],
		list_error_incidents: ["Listing error incidents"],
		list_error_issue_events: ["Reading issue history"],
		claim_error_issue: ["Claiming an issue"],
		release_error_issue: ["Releasing an issue"],
		transition_error_issue: ["Updating an issue's status"],
		comment_on_error_issue: ["Commenting on an issue"],
		set_issue_severity: ["Setting issue severity"],
		propose_fix: ["Drafting a fix"],
		link_pull_request: ["Linking a pull request"],
		// dashboards
		list_dashboards: ["Listing dashboards"],
		get_dashboard: ["Opening a dashboard", "Loading a dashboard"],
		describe_dashboard_schema: ["Reading the dashboard schema"],
		create_dashboard: ["Creating a dashboard"],
		update_dashboard: ["Updating a dashboard"],
		add_dashboard_widget: ["Adding a widget"],
		update_dashboard_widget: ["Updating a widget"],
		remove_dashboard_widget: ["Removing a widget"],
		reorder_dashboard_widgets: ["Reordering widgets"],
		replace_dashboard_widgets: ["Replacing widgets"],
		// alerts
		list_alert_rules: ["Listing alert rules", "Checking alert rules"],
		get_alert_rule: ["Reading an alert rule"],
		create_alert_rule: ["Creating an alert rule"],
		update_alert_rule: ["Updating an alert rule"],
		delete_alert_rule: ["Deleting an alert rule"],
		list_alert_incidents: ["Listing alert incidents", "Checking recent alerts"],
		list_alert_checks: ["Reading alert check history"],
		get_incident_timeline: ["Loading the incident timeline", "Building the incident timeline"],
		update_error_notification_policy: ["Updating the notification policy"],
		// sessions and product analytics
		search_sessions: ["Searching sessions"],
		get_session_traces: ["Loading session traces"],
		get_session_transcript: ["Reading a session transcript"],
		list_agent_sessions: ["Listing agent sessions"],
		get_agent_session: ["Opening an agent session"],
		get_agent_tools_overview: ["Checking agent tool usage"],
		get_agent_tool_error: ["Inspecting an agent tool error"],
		list_product_events: ["Listing product events"],
		query_funnel: ["Computing a funnel", "Querying a funnel"],
		register_agent: ["Registering an agent"],
		// source code
		list_source_repositories: ["Listing repositories"],
		search_source_code: ["Searching the code", "Searching source code"],
		read_source_file: ["Reading a source file", "Reading the code"],
		pr_changed_files: ["Listing changed files"],
		pr_file_diff: ["Reading a diff"],
		sandbox_grep: ["Searching the repository", "Grepping the code"],
		sandbox_list_files: ["Listing files"],
		sandbox_read_file: ["Reading a file"],
		sandbox_exec: ["Running a command"],
		// completion tools
		submit_diagnosis: ["Writing up the diagnosis"],
		submit_review: ["Writing up the review"],
	}),
)

/** FNV-1a: small, and the same everywhere, which is all a pick needs. */
const hash = (value: string): number => {
	let h = 0x811c9dc5
	for (let index = 0; index < value.length; index++) {
		h ^= value.charCodeAt(index)
		h = Math.imul(h, 0x01000193)
	}
	return h >>> 0
}

/**
 * The phrase for one call, picked by its id rather than at random.
 *
 * A channel message is re-rendered on every edit of a running turn, so a truly random pick would
 * reword the same call under the reader's eyes. Seeding by the call's id varies the phrase from
 * call to call and holds it still for the life of one.
 */
export const toolPhrase = (toolName: string, callId: string): string => {
	const phrases = PHRASES.get(toolName)
	if (phrases === undefined) return `Using ${toolName.replaceAll("_", " ")}`
	return phrases[hash(callId) % phrases.length]
}
