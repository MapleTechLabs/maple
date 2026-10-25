import { humanize } from "../../../lib/humanize"
import type { IconName } from "../../../ui/icon"

// A tool's label, icon and live activity.

/** Strips the `mcp__<server>__` prefix MCP tools arrive with. */
export const normalizeToolName = (toolName: string): string => toolName.replace(/^mcp__.+?__/, "")

const TOOL_LABELS = new Map<string, string>([
	// observability / diagnostics
	["system_health", "System Health"],
	["diagnose_service", "Diagnose Service"],
	["list_services", "List Services"],
	["service_map", "Service Map"],
	["get_service_top_operations", "Top Operations"],
	["explore_attributes", "Explore Attributes"],
	["describe_warehouse_tables", "Describe Tables"],
	["get_instrumentation_recommendations", "Instrumentation Tips"],
	// traces
	["search_traces", "Search Traces"],
	["find_slow_traces", "Find Slow Traces"],
	["inspect_trace", "Inspect Trace"],
	["inspect_span", "Inspect Span"],
	// logs
	["search_logs", "Search Logs"],
	["mine_log_patterns", "Mine Log Patterns"],
	// errors
	["find_errors", "Find Errors"],
	["error_detail", "Error Detail"],
	["list_error_issues", "List Error Issues"],
	["list_error_incidents", "List Error Incidents"],
	["list_error_issue_events", "Error Issue Events"],
	["claim_error_issue", "Claim Issue"],
	["release_error_issue", "Release Issue"],
	["transition_error_issue", "Transition Issue"],
	["transition_error_issues", "Transition Issues"],
	["comment_on_error_issue", "Comment on Issue"],
	["set_issue_severity", "Set Issue Severity"],
	["propose_fix", "Propose Fix"],
	// metrics & charts
	["list_metrics", "List Metrics"],
	["query_data", "Query Data"],
	["inspect_chart_data", "Inspect Chart Data"],
	["compare_periods", "Compare Periods"],
	// dashboards
	["list_dashboards", "List Dashboards"],
	["get_dashboard", "Get Dashboard"],
	["create_dashboard", "Create Dashboard"],
	["update_dashboard", "Update Dashboard"],
	["add_dashboard_widget", "Add Widget"],
	["update_dashboard_widget", "Update Widget"],
	["remove_dashboard_widget", "Remove Widget"],
	["reorder_dashboard_widgets", "Reorder Widgets"],
	["replace_dashboard_widgets", "Replace Widgets"],
	// alerts & incidents
	["list_alert_rules", "List Alert Rules"],
	["list_alert_destinations", "List Alert Destinations"],
	["get_alert_rule", "Get Alert Rule"],
	["create_alert_rule", "Create Alert Rule"],
	["update_alert_rule", "Update Alert Rule"],
	["delete_alert_rule", "Delete Alert Rule"],
	["list_alert_incidents", "List Alert Incidents"],
	["list_alert_checks", "List Alert Checks"],
	["preview_alert_rule", "Preview Alert Rule"],
	["get_incident_timeline", "Incident Timeline"],
	["get_error_notification_policy", "Notification Policy"],
	["update_error_notification_policy", "Notification Policy"],
	// sessions
	["search_sessions", "Search Sessions"],
	["get_session_traces", "Session Traces"],
	["get_session_transcript", "Session Transcript"],
	// agent sessions (AI/LLM agent traces)
	["list_agent_sessions", "Agent Sessions"],
	["get_agent_session", "Agent Session"],
	["get_agent_session_transcript", "Agent Session Transcript"],
	["get_agent_tools_overview", "Agent Tool Usage"],
	["get_agent_tool_error", "Agent Tool Error"],
	// misc
	["run_sql", "Run SQL"],
	["register_agent", "Register Agent"],
	["send_maple_feedback", "Send Feedback"],
	["get_event", "Get Event"],
])

const TOOL_ICONS = new Map<string, IconName>([
	["system_health", "PulseIcon"],
	["diagnose_service", "PulseIcon"],
	["list_services", "ServerIcon"],
	["service_map", "NetworkNodesIcon"],
	["get_service_top_operations", "ChartBarTrendUpIcon"],
	["explore_attributes", "TagIcon"],
	["describe_warehouse_tables", "DatabaseIcon"],
	["get_instrumentation_recommendations", "BoltIcon"],
	["search_traces", "NetworkNodesIcon"],
	["find_slow_traces", "ClockIcon"],
	["inspect_trace", "MagnifierIcon"],
	["inspect_span", "MagnifierIcon"],
	["search_logs", "DatabaseIcon"],
	["mine_log_patterns", "DatabaseIcon"],
	["find_errors", "CircleXmarkIcon"],
	["error_detail", "CircleWarningIcon"],
	["list_error_issues", "FireIcon"],
	["list_error_incidents", "FireIcon"],
	["list_error_issue_events", "FireIcon"],
	["claim_error_issue", "FireIcon"],
	["release_error_issue", "FireIcon"],
	["transition_error_issue", "FireIcon"],
	["transition_error_issues", "FireIcon"],
	["comment_on_error_issue", "ChatBubbleSparkleIcon"],
	["set_issue_severity", "AlertWarningIcon"],
	["propose_fix", "BoltIcon"],
	["list_metrics", "ChartBarIcon"],
	["query_data", "ChartLineIcon"],
	["inspect_chart_data", "ChartLineIcon"],
	["compare_periods", "ClockIcon"],
	["list_dashboards", "GridIcon"],
	["get_dashboard", "GridIcon"],
	["create_dashboard", "GridSquareCirclePlusIcon"],
	["update_dashboard", "PencilIcon"],
	["add_dashboard_widget", "GridSquareCirclePlusIcon"],
	["update_dashboard_widget", "PencilIcon"],
	["remove_dashboard_widget", "TrashIcon"],
	["reorder_dashboard_widgets", "SlidersIcon"],
	["replace_dashboard_widgets", "GridIcon"],
	["list_alert_rules", "BellIcon"],
	["list_alert_destinations", "BellIcon"],
	["get_alert_rule", "BellIcon"],
	["create_alert_rule", "BellIcon"],
	["update_alert_rule", "BellIcon"],
	["delete_alert_rule", "TrashIcon"],
	["list_alert_incidents", "AlertWarningIcon"],
	["list_alert_checks", "CircleCheckIcon"],
	["preview_alert_rule", "HistoryIcon"],
	["get_incident_timeline", "HistoryIcon"],
	["get_error_notification_policy", "BellIcon"],
	["update_error_notification_policy", "BellIcon"],
	["run_sql", "DatabaseIcon"],
	["search_sessions", "HistoryIcon"],
	["get_session_traces", "HistoryIcon"],
	["get_session_transcript", "ChatBubbleSparkleIcon"],
	["list_agent_sessions", "ChatBubbleSparkleIcon"],
	["get_agent_session", "ChatBubbleSparkleIcon"],
	["get_agent_session_transcript", "ChatBubbleSparkleIcon"],
	["get_agent_tools_overview", "ChartBarTrendUpIcon"],
	["get_agent_tool_error", "FireIcon"],
	["register_agent", "IdBadgeIcon"],
	["send_maple_feedback", "ChatBubbleSparkleIcon"],
	["get_event", "CircleInfoIcon"],
])

export const toolLabel = (toolName: string): string => {
	const name = normalizeToolName(toolName)
	return TOOL_LABELS.get(name) ?? humanize(name)
}

export const toolIcon = (toolName: string): IconName =>
	TOOL_ICONS.get(normalizeToolName(toolName)) ?? "CodeIcon"

/** Verbs that survive being turned into a present participle. */
const LABEL_VERBS = new Set([
	"Add",
	"Claim",
	"Comment",
	"Compare",
	"Create",
	"Delete",
	"Describe",
	"Diagnose",
	"Explore",
	"Find",
	"Get",
	"Inspect",
	"List",
	"Mine",
	"Propose",
	"Query",
	"Register",
	"Release",
	"Remove",
	"Reorder",
	"Replace",
	"Run",
	"Search",
	"Set",
	"Transition",
	"Update",
])

const IRREGULAR_PARTICIPLE = new Map([
	["Get", "Getting"],
	["Run", "Running"],
	["Set", "Setting"],
])

const participle = (verb: string): string =>
	IRREGULAR_PARTICIPLE.get(verb) ?? (verb.endsWith("e") ? `${verb.slice(0, -1)}ing` : `${verb}ing`)

/** What a running call is doing: `Searching Traces`, `Checking System Health`. */
export const toolActivity = (toolName: string): string => {
	const label = toolLabel(toolName)
	const [first = "", ...rest] = label.split(" ")
	if (!LABEL_VERBS.has(first)) return `Checking ${label}`
	return [participle(first), ...rest].join(" ")
}
