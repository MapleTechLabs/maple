import { type AutoContext, deriveAutoContexts } from "../../../components/chat/auto-contexts"
import type { InvestigationContext, WidgetFixContext } from "./subject"

// `buildContextPreamble`: the context blocks sent to the model ahead of a message. Their text is
// part of what the model reads, so change it deliberately.

const formatAutoContextLine = (context: AutoContext): string => {
	switch (context.kind) {
		case "service":
			return `- service: ${context.serviceName}`
		case "trace":
			return `- trace: ${context.traceId}`
		case "dashboard":
			return context.widgetId
				? `- dashboard: ${context.dashboardId} (widget: ${context.widgetId})`
				: `- dashboard: ${context.dashboardId}`
		case "error_type":
			return `- error_type: ${context.errorType}`
		case "error_issue":
			return `- error_issue: ${context.issueId}`
		case "alert_rule":
			return `- alert_rule: ${context.ruleId}`
		case "host":
			return `- host: ${context.hostName}`
		case "container":
			return `- container: ${context.containerName}`
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

/** The referrer's contexts the user has not dismissed (`activeContexts`). */
export const activeContextsOf = (
	referrerPath: string | null,
	dismissed: ReadonlyArray<string>,
): ReadonlyArray<AutoContext> =>
	referrerPath === null
		? []
		: deriveAutoContexts(referrerPath).filter((context) => !dismissed.includes(context.id))

/** The first message's context block for the page the user came from; "" with no contexts. */
export const pageContextPreamble = (
	pathname: string | null,
	contexts: ReadonlyArray<AutoContext>,
): string => {
	if (pathname === null || contexts.length === 0) return ""
	return [
		"",
		"## Current Page Context",
		'The user is viewing the following Maple page. Treat these entities as the implicit subject when the user says "this", "here", or asks open-ended questions without naming a target. The user can dismiss any of these chips, so respect what\'s listed below.',
		"",
		`page: ${pathname}`,
		...contexts.map(formatAutoContextLine),
	]
		.join("\n")
		.trim()
}

/** `formatWidgetFixContextBlock`, trimmed. The heading's dash is wire text. */
export const widgetFixPreamble = (ctx: WidgetFixContext): string =>
	[
		"",
		"## Broken Widget \u2014 Propose a Fix",
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
		"- Maple renders an approval card for `update_dashboard_widget` automatically \u2014 do not narrate the approval step or emit Approve/Deny prose. Just call the tool.",
		"- After the user approves, briefly confirm what changed and why.",
	]
		.join("\n")
		.trim()

const LATENCY_HINT =
	"- Prefer `find_slow_traces` and `get_service_top_operations` for the affected service.\n- Use `inspect_trace` on the slowest representative traces."

const SIGNAL_TOOL_HINTS = new Map([
	[
		"error_rate",
		"- Prefer `find_errors` and `list_error_issues` for the affected service.\n- Use `search_logs` to surface exception messages in the alert window.",
	],
	["p95_latency", LATENCY_HINT],
	["p99_latency", LATENCY_HINT],
	[
		"apdex",
		"- Investigate both latency and errors: `find_slow_traces`, `find_errors`, and `get_service_top_operations`.",
	],
	[
		"throughput",
		"- Use `compare_periods` to contrast the alert window against the prior equivalent window.\n- `service_map` can reveal upstream dependencies that dropped or surged.",
	],
	["metric", "- Use `query_data` or `inspect_chart_data` to pull the raw metric values across the window."],
])

const KIND_HEADING = {
	alert: "Attached Alert",
	anomaly: "Attached Anomaly",
	error: "Attached Error",
	freeform: "Investigation subject",
} satisfies Record<InvestigationContext["kind"], string>

const ERROR_TOOL_HINTS =
	"- Prefer `error_detail`, `find_errors`, and `list_error_issue_events` for this issue.\n- Use `search_logs` and `inspect_trace` on representative occurrences to read stack traces."

const toolHints = (ctx: InvestigationContext): string =>
	ctx.kind === "error"
		? ERROR_TOOL_HINTS
		: ((ctx.signalType === undefined ? undefined : SIGNAL_TOOL_HINTS.get(ctx.signalType)) ??
			"- Use `diagnose_service` and `explore_attributes` on the affected service.")

const subjectPhrase = (kind: InvestigationContext["kind"]): string =>
	kind === "error"
		? "an error issue"
		: kind === "freeform"
			? "a free-form subject"
			: `a${kind === "anomaly" ? "n" : ""} ${kind}`

/** `formatInvestigationContextBlock`, trimmed. */
export const investigationPreamble = (ctx: InvestigationContext): string => {
	const scope = ctx.scope ?? ctx.refs?.serviceName ?? "all"
	const triage =
		ctx.aiSummary || ctx.aiSuspectedCause
			? [
					"",
					"### Prior AI triage",
					"An automated triage pass already ran. Build on it \u2014 verify, deepen, or correct it rather than starting from scratch.",
					...(ctx.aiSummary ? [`- summary: ${ctx.aiSummary}`] : []),
					...(ctx.aiSuspectedCause ? [`- suspected_cause: ${ctx.aiSuspectedCause}`] : []),
				]
			: []
	return [
		"",
		`## ${KIND_HEADING[ctx.kind]}`,
		`The on-call engineer is investigating ${subjectPhrase(ctx.kind)} that is attached to this conversation as structured context. It is pinned above the message thread and stays attached to every message.`,
		"",
		"```yaml",
		`kind: ${ctx.kind}`,
		`id: ${ctx.id}`,
		`title: ${JSON.stringify(ctx.title)}`,
		`severity: ${ctx.severity}`,
		`status: ${ctx.status}`,
		...(ctx.signalType ? [`signal: ${ctx.signalType}`] : []),
		...ctx.facts.map((fact) => `${fact.key}: ${JSON.stringify(fact.value)}`),
		...(ctx.refs?.serviceName ? [`service: ${ctx.refs.serviceName}`] : []),
		...(ctx.refs?.ruleId ? [`rule_id: ${ctx.refs.ruleId}`] : []),
		...(ctx.refs?.detectorKey ? [`detector_key: ${ctx.refs.detectorKey}`] : []),
		...(ctx.refs?.issueId ? [`error_issue_id: ${ctx.refs.issueId}`] : []),
		"```",
		"",
		"### Investigation guidance",
		`- Scope every query to \`${scope}\` unless the engineer explicitly broadens it.`,
		ctx.windowMinutes
			? `- Default time range: the ${ctx.windowMinutes}m window ending at the event time, with ~15m of surrounding context. Widen if needed.`
			: "- Default time range: the incident's active window with ~15m of surrounding context.",
		"- Treat the attachment as authoritative \u2014 do not ask the engineer to repeat values it already contains.",
		toolHints(ctx),
		"- Prefer existing Maple routes (services, traces, errors, alerts, anomalies) when you recommend links.",
		...triage,
	]
		.join("\n")
		.trim()
}
