/**
 * Base names of the mutating MCP tools that the AI chat gates behind approval.
 *
 * The in-process chat agent (`apps/api/src/chat/`) interrupts the turn on these
 * tools instead of executing them; the web client applies the real change via
 * `POST /internal/chat/apply`, which only accepts tools in this set.
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
	"comment_on_error_issue",
	"set_issue_severity",
	"update_error_notification_policy",
	// fixes / agents
	"propose_fix",
	"link_pull_request",
	"register_agent",
])
