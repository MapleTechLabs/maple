/**
 * Base names of the mutating MCP tools that the AI chat gates behind approval.
 *
 * The in-process chat agent (`apps/api/src/chat/`) interrupts the turn on these
 * tools instead of executing them; an approval runs the real change through
 * `ChatSession.settleProposal`, whose applier only accepts tools in this set.
 */
export const MUTATING_TOOL_NAMES: ReadonlySet<string> = new Set([
	// dashboards
	"create_dashboard",
	"update_dashboard",
	"add_dashboard_widget",
	"update_dashboard_widget",
	"remove_dashboard_widget",
	"reorder_dashboard_widgets",
	"replace_dashboard_widgets",
	// alerts
	"create_alert_rule",
	"update_alert_rule",
	"delete_alert_rule",
	// error issues
	"claim_error_issue",
	"release_error_issue",
	"transition_error_issue",
	"transition_error_issues",
	"comment_on_error_issue",
	"set_issue_severity",
	"update_error_notification_policy",
	// fixes / agents
	"propose_fix",
	"link_pull_request",
	"register_agent",
	// integrations
	"sync_railway",
	"create_scrape_target",
	"update_scrape_target",
	"delete_scrape_target",
	// uptime monitors
	"create_uptime_monitor",
	"update_uptime_monitor",
	"delete_uptime_monitor",
	// ingest rules
	"create_ingest_rule",
	"update_ingest_rule",
	"delete_ingest_rule",
	// status pages: every post is public text on the customer's page
	"create_status_page_incident",
	"post_status_page_update",
	"resolve_status_page_incident",
	"schedule_status_page_maintenance",
	"apply_status_page_config",
	// feedback
	"send_maple_feedback",
])
