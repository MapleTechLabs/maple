import type { AlertContext } from "./alert-context"
import type { WidgetFixContext } from "./widget-fix-context"
import type { AutoContext, PageContextPayload } from "./auto-contexts"

/**
 * Per-conversation context (alert / widget-fix / page) delivery for the Flue
 * chat backend.
 *
 * The legacy chat agent received this context out-of-band in the request `body`
 * and merged it into the system prompt. Flue's `agents.send` carries only a
 * message string, so we fold the same structured blocks into a preamble on the
 * conversation's FIRST message instead. The blocks are wrapped in sentinel
 * markers so the renderer can strip them from the user's visible bubble while
 * the model still receives them (see {@link wrapContextPreamble} /
 * {@link stripContextPreamble}).
 *
 * The formatters below are ported verbatim from the legacy agent so the model
 * sees an identical context shape.
 */

export interface ChatContext {
	mode?: "alert" | "widget-fix"
	alertContext?: AlertContext
	widgetFixContext?: WidgetFixContext
	pageContext?: PageContextPayload
}

const CONTEXT_OPEN = "<!--maple:context-->"
const CONTEXT_CLOSE = "<!--/maple:context-->"

/** Prepend a context block to a user message, fenced by strip-able sentinels. */
export const wrapContextPreamble = (block: string, userText: string): string =>
	`${CONTEXT_OPEN}\n${block}\n${CONTEXT_CLOSE}\n\n${userText}`

/** Remove a leading context block (if present) so the user's bubble stays clean. */
export const stripContextPreamble = (text: string): string => {
	const start = text.indexOf(CONTEXT_OPEN)
	if (start !== 0) return text
	const end = text.indexOf(CONTEXT_CLOSE)
	if (end === -1) return text
	return text.slice(end + CONTEXT_CLOSE.length).replace(/^\s+/, "")
}

/** Build the context block for a conversation, or "" when there's nothing to attach. */
export const buildContextPreamble = (ctx: ChatContext): string => {
	if (ctx.mode === "alert" && ctx.alertContext) return formatAlertContextBlock(ctx.alertContext).trim()
	if (ctx.mode === "widget-fix" && ctx.widgetFixContext) {
		return formatWidgetFixContextBlock(ctx.widgetFixContext).trim()
	}
	if (ctx.mode !== "widget-fix" && ctx.pageContext && ctx.pageContext.contexts.length > 0) {
		return formatPageContextBlock(ctx.pageContext).trim()
	}
	return ""
}

// ---------------------------------------------------------------------------
// Formatters (ported from apps/chat-agent/src/index.ts)
// ---------------------------------------------------------------------------

const formatAutoContextLine = (ctx: AutoContext): string => {
	switch (ctx.kind) {
		case "service":
			return `- service: ${ctx.serviceName}`
		case "trace":
			return `- trace: ${ctx.traceId}`
		case "dashboard":
			return ctx.widgetId
				? `- dashboard: ${ctx.dashboardId} (widget: ${ctx.widgetId})`
				: `- dashboard: ${ctx.dashboardId}`
		case "error_type":
			return `- error_type: ${ctx.errorType}`
		case "error_issue":
			return `- error_issue: ${ctx.issueId}`
		case "alert_rule":
			return `- alert_rule: ${ctx.ruleId}`
		case "host":
			return `- host: ${ctx.hostName}`
		case "logs_explorer":
			return "- view: logs explorer"
		case "metrics_explorer":
			return "- view: metrics explorer"
		case "traces_explorer":
			return "- view: traces explorer"
		case "service_map":
			return "- view: service map"
	}
}

const formatPageContextBlock = (payload: PageContextPayload): string => {
	if (payload.contexts.length === 0) return ""
	const lines = [
		"",
		"## Current Page Context",
		'The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says "this", "here", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what\'s listed below.',
		"",
		`page: ${payload.pathname}`,
		...payload.contexts.map(formatAutoContextLine),
	]
	return lines.join("\n")
}

const formatAlertComparator = (c: string): string => {
	switch (c) {
		case "gt":
			return ">"
		case "gte":
			return ">="
		case "lt":
			return "<"
		case "lte":
			return "<="
		default:
			return c
	}
}

const SIGNAL_TOOL_HINTS: Record<string, string> = {
	error_rate:
		"- Prefer `find_errors` and `list_error_issues` for the affected service.\n- Use `search_logs` to surface exception messages in the alert window.",
	p95_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	p99_latency:
		"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces.",
	apdex: "- Investigate both latency and errors: `find_slow_traces`, `find_errors`, and `get_service_top_operations`.",
	throughput:
		"- Use `compare_periods` to contrast the alert window against the prior equivalent window.\n- `service_map` can reveal upstream dependencies that dropped or surged.",
	metric: "- Use `query_data` or `inspect_chart_data` to pull the raw metric values across the window.",
}

const formatWidgetFixContextBlock = (ctx: WidgetFixContext): string => {
	const lines = [
		"",
		"## Broken Widget — Propose a Fix",
		"The user is on a dashboard with a widget that is failing schema validation. The full widget JSON and the validation error are attached. Diagnose what is wrong with the widget config, then call `update_dashboard_widget` with a corrected `widget_json`.",
		"",
		`dashboard_id: ${ctx.dashboardId}`,
		`widget_id: ${ctx.widgetId}`,
		`widget_title: ${JSON.stringify(ctx.widgetTitle)}`,
		"",
		"### Validation error",
		ctx.errorTitle ? `- ${ctx.errorTitle}` : "- (no title)",
		ctx.errorMessage ? `- ${ctx.errorMessage}` : "- (no message)",
		"",
		"### Current widget config",
		"```json",
		ctx.widgetJson,
		"```",
		"",
		"### Fix-mode rules",
		"- Treat the widget JSON as the single source of truth. Modify only what the validation error requires.",
		"- Do NOT change `id`, `layout`, or `visualization` unless the schema error explicitly requires it.",
		"- Preserve `display.title` and other display config that is not implicated by the error.",
		"- Call `update_dashboard_widget` with `dashboard_id`, `widget_id`, and a complete corrected `widget_json` (full widget object as a JSON string).",
		"- Maple renders an approval card for `update_dashboard_widget` automatically — do not narrate the approval step or emit Approve/Deny prose. Just call the tool.",
		"- After the user approves, briefly confirm what changed and why.",
	]
	return lines.join("\n")
}

const formatAlertContextBlock = (alert: AlertContext): string => {
	const observedRaw = alert.value === null ? "n/a" : String(alert.value)
	const thresholdExpr = `${formatAlertComparator(alert.comparator)} ${alert.threshold}`
	const toolHints =
		SIGNAL_TOOL_HINTS[alert.signalType] ??
		"- Use `diagnose_service` and `explore_attributes` on the affected service."

	const lines = [
		"",
		"## Attached Alert",
		"The on-call engineer is investigating an alert that has been attached to this conversation as structured context. It is visible to them as a pinned card above the message thread, and it remains attached to every message in this thread.",
		"",
		"```yaml",
		`rule_id: ${alert.ruleId}`,
		`rule_name: ${JSON.stringify(alert.ruleName)}`,
		`incident_id: ${alert.incidentId ?? "null"}`,
		`event_type: ${alert.eventType}`,
		`severity: ${alert.severity}`,
		`signal: ${alert.signalType}`,
		`threshold: ${thresholdExpr}`,
		`observed: ${observedRaw}`,
		`sample_count: ${alert.sampleCount ?? "null"}`,
		`window_minutes: ${alert.windowMinutes}`,
		`group_key: ${alert.groupKey === null ? "null" : JSON.stringify(alert.groupKey)}`,
		"```",
		"",
		"### Investigation guidance",
		`- Scope every query to service/group \`${alert.groupKey ?? "all"}\` unless the engineer explicitly broadens it.`,
		`- Default time range: the alert window (${alert.windowMinutes}m ending at the event time) with ~15m of surrounding context. Widen if needed.`,
		`- Treat the attachment as authoritative — do not ask the engineer to repeat values it already contains. Reference the rule by name, not by ID.`,
		toolHints,
		"- When you recommend dashboards or links, prefer existing Maple routes (services, traces, errors, alerts). Use `get_alert_rule`/`list_alert_incidents` if you need deeper rule history.",
		"- If the event is `resolve`, focus on root-cause and prevention rather than immediate mitigation.",
	]

	if (alert.aiSummary || alert.aiSuspectedCause) {
		lines.push(
			"",
			"### Prior AI triage",
			"An automated triage pass already ran on this incident. Build on it — verify, deepen, or correct it rather than starting from scratch.",
		)
		if (alert.aiSummary) lines.push(`- summary: ${alert.aiSummary}`)
		if (alert.aiSuspectedCause) lines.push(`- suspected_cause: ${alert.aiSuspectedCause}`)
	}

	return lines.join("\n")
}
