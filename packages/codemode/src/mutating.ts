/**
 * Base names of the mutating Maple MCP tools — the **single source of truth**
 * for approval gating, imported by both apps/api and apps/chat-flue so the lists
 * can't drift.
 *
 * Enforcement points:
 * - apps/chat-flue wraps these so a model call returns a `proposed` marker
 *   instead of mutating (the web client applies the real change via
 *   `POST /api/chat/apply`, which only accepts tools in this set).
 * - The MCP `run_code` sandbox (apps/api) refuses these, so a snippet can't
 *   trigger an ungated mutation.
 *
 * Because `run_code` makes this set fail **open** (a name absent from it runs
 * its real handler), apps/api has a regression test asserting every
 * conventionally-named mutating tool in the registry is present here — add a
 * mutating tool without gating it and CI fails.
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

/**
 * Name prefixes that denote a state-changing tool in Maple's verb_noun tool
 * taxonomy. Used by the apps/api regression test to fail CI when a tool that
 * looks mutating is missing from {@link MUTATING_TOOL_NAMES}. Keep read-only
 * verbs (find/get/list/search/inspect/describe/query/run/…) out of this list.
 */
export const MUTATING_TOOL_PREFIXES: ReadonlyArray<string> = [
	"create_",
	"update_",
	"delete_",
	"add_",
	"remove_",
	"reorder_",
	"replace_",
	"claim_",
	"release_",
	"transition_",
	"comment_",
	"heartbeat_",
	"set_",
	"propose_",
	"register_",
	"archive_",
	"restore_",
	"enable_",
	"disable_",
	"mute_",
	"unmute_",
	"rename_",
	"assign_",
	"acknowledge_",
	"snooze_",
	"resolve_",
	"reopen_",
	"close_",
]

/** True when a tool name looks state-changing by Maple's verb_noun convention. */
export const looksMutating = (name: string): boolean =>
	MUTATING_TOOL_PREFIXES.some((prefix) => name.startsWith(prefix))
