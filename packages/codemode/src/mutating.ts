/**
 * Base names of the mutating Maple MCP tools — the static list the cross-app /
 * over-MCP consumers use, shared by apps/api and apps/chat-flue so they can't
 * drift:
 * - apps/chat-flue wraps these so a model call returns a `proposed` marker
 *   instead of mutating (the web client applies the real change via
 *   `POST /api/chat/apply`, which only accepts tools in this set).
 * - apps/api's MCP `run_code` sandbox refuses them.
 *
 * The structural source of truth is the per-tool `mutating` flag set at
 * registration via `server.mutatingTool(...)`; an apps/api test asserts this
 * list exactly equals the set of tools registered that way, so adding a mutating
 * tool without listing it here (or vice versa) fails CI.
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
	"heartbeat_error_issue",
	"set_issue_severity",
	"update_error_notification_policy",
	// fixes / agents
	"propose_fix",
	"register_agent",
])
